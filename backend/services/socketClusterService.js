const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const cluster = require('cluster');
const os = require('os');

class SocketClusterService {
  constructor() {
    this.redisClients = null;
    this.adapter = null;
    this.numCPUs = os.cpus().length;
  }

  // Redis Adapter 설정 (다중 서버 간 Socket.IO 통신)
  async setupRedisAdapter(io) {
    try {
      // Redis 클라이언트 2개 생성 (pub/sub용)
      const pubClient = createClient({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retry_strategy: (options) => {
          if (options.error && options.error.code === 'ECONNREFUSED') {
            return new Error('Redis server refused connection');
          }
          if (options.total_retry_time > 1000 * 60 * 60) {
            return new Error('Retry time exhausted');
          }
          if (options.attempt > 10) {
            return undefined;
          }
          return Math.min(options.attempt * 100, 3000);
        }
      });

      const subClient = pubClient.duplicate();

      await Promise.all([
        pubClient.connect(),
        subClient.connect()
      ]);

      // Redis Adapter 생성
      this.adapter = createAdapter(pubClient, subClient);
      io.adapter(this.adapter);

      this.redisClients = { pubClient, subClient };

      console.log('✅ Socket.IO Redis Adapter connected');
      return true;
    } catch (error) {
      console.error('❌ Failed to setup Redis Adapter:', error);
      return false;
    }
  }

  // 클러스터 모드 시작
  startCluster() {
    if (cluster.isMaster) {
      console.log(`🚀 Master process ${process.pid} is running`);
      console.log(`🔥 Starting ${this.numCPUs} worker processes...`);

      // CPU 코어 수만큼 워커 생성
      for (let i = 0; i < this.numCPUs; i++) {
        cluster.fork();
      }

      // 워커 프로세스 모니터링
      cluster.on('exit', (worker, code, signal) => {
        console.log(`💀 Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork(); // 자동 재시작
      });

      // 워커 상태 모니터링
      setInterval(() => {
        const workers = Object.keys(cluster.workers).length;
        console.log(`📊 Active workers: ${workers}/${this.numCPUs}`);
      }, 30000); // 30초마다 체크

    } else {
      // 워커 프로세스에서 서버 시작
      console.log(`👷 Worker ${process.pid} started`);
      return true; // 워커에서 서버 시작 신호
    }
    return false;
  }

  // 부하 분산을 위한 방 분산 로직
  getOptimalRoom(userId, availableRooms) {
    // 사용자 ID 해시를 기반으로 방 분산
    const hash = this.hashUserId(userId);
    const roomIndex = hash % availableRooms.length;
    return availableRooms[roomIndex];
  }

  // 사용자 ID 해시 함수
  hashUserId(userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      const char = userId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 32bit 정수로 변환
    }
    return Math.abs(hash);
  }

  // Socket.IO 네임스페이스 분산
  createNamespaces(io) {
    const namespaces = {
      chat: io.of('/chat'),
      files: io.of('/files'),
      notifications: io.of('/notifications')
    };

    // 각 네임스페이스별 연결 제한
    Object.entries(namespaces).forEach(([name, namespace]) => {
      namespace.use((socket, next) => {
        const connections = namespace.sockets.size;
        const limit = this.getNamespaceLimit(name);
        
        if (connections >= limit) {
          console.warn(`🚨 Namespace ${name} connection limit reached: ${connections}/${limit}`);
          return next(new Error(`Namespace ${name} is full`));
        }
        
        next();
      });
    });

    return namespaces;
  }

  // 네임스페이스별 연결 제한
  getNamespaceLimit(namespace) {
    const limits = {
      chat: 300,      // 채팅 전용
      files: 100,     // 파일 업로드 전용
      notifications: 500  // 알림 전용
    };
    return limits[namespace] || 100;
  }

  // 메시지 브로드캐스팅 최적화
  async optimizedBroadcast(io, roomId, event, data) {
    try {
      // 방에 있는 실제 사용자 수 확인
      const sockets = await io.in(roomId).fetchSockets();
      
      if (sockets.length === 0) {
        console.log(`📭 No users in room ${roomId}, skipping broadcast`);
        return;
      }

      // 대용량 데이터는 압축해서 전송
      if (JSON.stringify(data).length > 1024) { // 1KB 이상
        data = await this.compressData(data);
      }

      // 배치 브로드캐스팅 (한 번에 최대 50명씩)
      const batchSize = 50;
      for (let i = 0; i < sockets.length; i += batchSize) {
        const batch = sockets.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(socket => 
            socket.emit(event, data).catch(err => 
              console.error(`Failed to emit to ${socket.id}:`, err)
            )
          )
        );
        
        // 배치 간 짧은 지연 (서버 부하 방지)
        if (i + batchSize < sockets.length) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      console.log(`📡 Broadcasted ${event} to ${sockets.length} users in room ${roomId}`);
    } catch (error) {
      console.error('Broadcast error:', error);
    }
  }

  // 데이터 압축
  async compressData(data) {
    const zlib = require('zlib');
    const compressed = zlib.gzipSync(JSON.stringify(data));
    return {
      compressed: true,
      data: compressed.toString('base64')
    };
  }

  // 연결 풀 관리
  manageConnectionPool(io) {
    const connectionPool = {
      active: new Map(),
      idle: new Set(),
      maxConnections: 1000,
      idleTimeout: 5 * 60 * 1000 // 5분
    };

    // 연결 추가
    io.on('connection', (socket) => {
      connectionPool.active.set(socket.id, {
        socket,
        lastActivity: Date.now(),
        userId: socket.user?.id
      });

      // 비활성 연결 감지
      socket.on('disconnect', () => {
        connectionPool.active.delete(socket.id);
        connectionPool.idle.delete(socket.id);
      });

      // 활동 업데이트
      socket.onAny(() => {
        const conn = connectionPool.active.get(socket.id);
        if (conn) {
          conn.lastActivity = Date.now();
        }
      });
    });

    // 비활성 연결 정리 (1분마다)
    setInterval(() => {
      const now = Date.now();
      const toRemove = [];

      for (const [socketId, conn] of connectionPool.active) {
        if (now - conn.lastActivity > connectionPool.idleTimeout) {
          toRemove.push(socketId);
        }
      }

      toRemove.forEach(socketId => {
        const conn = connectionPool.active.get(socketId);
        if (conn) {
          console.log(`🧹 Cleaning idle connection: ${socketId}`);
          conn.socket.disconnect(true);
          connectionPool.active.delete(socketId);
        }
      });

      console.log(`📊 Connection Pool - Active: ${connectionPool.active.size}, Cleaned: ${toRemove.length}`);
    }, 60000);

    return connectionPool;
  }

  // 메모리 기반 메시지 큐 (Redis 보완)
  createMessageQueue() {
    const messageQueue = {
      queues: new Map(),
      processing: new Set(),
      maxQueueSize: 1000,
      batchSize: 10
    };

    // 메시지 큐에 추가
    messageQueue.enqueue = (roomId, message) => {
      if (!messageQueue.queues.has(roomId)) {
        messageQueue.queues.set(roomId, []);
      }

      const queue = messageQueue.queues.get(roomId);
      if (queue.length >= messageQueue.maxQueueSize) {
        queue.shift(); // 오래된 메시지 제거
      }

      queue.push({
        ...message,
        timestamp: Date.now(),
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      });
    };

    // 배치 처리
    messageQueue.processBatch = async (roomId) => {
      if (messageQueue.processing.has(roomId)) return;

      messageQueue.processing.add(roomId);
      const queue = messageQueue.queues.get(roomId) || [];
      
      if (queue.length === 0) {
        messageQueue.processing.delete(roomId);
        return;
      }

      const batch = queue.splice(0, messageQueue.batchSize);
      
      try {
        // 데이터베이스에 배치 저장
        await this.saveBatchMessages(batch);
        console.log(`💾 Saved batch of ${batch.length} messages for room ${roomId}`);
      } catch (error) {
        console.error('Batch save error:', error);
        // 실패한 메시지들을 큐 앞쪽에 다시 추가
        queue.unshift(...batch);
      } finally {
        messageQueue.processing.delete(roomId);
      }
    };

    // 주기적 배치 처리 (5초마다)
    setInterval(() => {
      for (const roomId of messageQueue.queues.keys()) {
        messageQueue.processBatch(roomId);
      }
    }, 5000);

    return messageQueue;
  }

  // 배치 메시지 저장
  async saveBatchMessages(messages) {
    const Message = require('../models/Message');
    
    try {
      await Message.insertMany(messages, { ordered: false });
    } catch (error) {
      console.error('Batch message save error:', error);
      throw error;
    }
  }

  // 서버 상태 모니터링
  monitorServerHealth(io) {
    const healthMetrics = {
      connections: 0,
      memoryUsage: 0,
      cpuUsage: 0,
      lastCheck: Date.now()
    };

    setInterval(() => {
      const memUsage = process.memoryUsage();
      healthMetrics.connections = io.engine.clientsCount;
      healthMetrics.memoryUsage = memUsage.heapUsed / memUsage.heapTotal;
      healthMetrics.lastCheck = Date.now();

      // 임계치 초과 시 경고
      if (healthMetrics.memoryUsage > 0.8) {
        console.warn(`⚠️ High memory usage: ${(healthMetrics.memoryUsage * 100).toFixed(2)}%`);
      }

      if (healthMetrics.connections > 800) {
        console.warn(`⚠️ High connection count: ${healthMetrics.connections}`);
      }

      // 메트릭을 Redis에 저장 (모니터링용)
      this.saveHealthMetrics(healthMetrics);
    }, 10000); // 10초마다

    return healthMetrics;
  }

  // 헬스 메트릭 저장
  async saveHealthMetrics(metrics) {
    try {
      const redisClient = require('../utils/redisClient');
      await redisClient.setEx(
        `server:health:${process.pid}`,
        30,
        JSON.stringify({
          ...metrics,
          pid: process.pid,
          timestamp: new Date()
        })
      );
    } catch (error) {
      console.error('Failed to save health metrics:', error);
    }
  }

  // 정리 작업
  async cleanup() {
    if (this.redisClients) {
      await Promise.all([
        this.redisClients.pubClient.quit(),
        this.redisClients.subClient.quit()
      ]);
    }
  }
}

module.exports = new SocketClusterService(); 