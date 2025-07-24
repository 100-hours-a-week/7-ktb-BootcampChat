// 🗄️ MongoDB 샤딩 클러스터 설정 (6개 인스턴스)
const mongoCluster = {
  // 🔥 샤딩 클러스터 구성
  shards: [
    {
      name: 'shard01',
      servers: ['mongodb01:27017', 'mongodb02:27017'],
      primary: 'mongodb01:27017'
    },
    {
      name: 'shard02', 
      servers: ['mongodb03:27017', 'mongodb04:27017'],
      primary: 'mongodb03:27017'
    },
    {
      name: 'shard03',
      servers: ['mongodb05:27017', 'mongodb06:27017'], 
      primary: 'mongodb05:27017'
    }
  ],
  
  // 🎯 샤딩 키 전략
  shardingKeys: {
    users: { _id: 'hashed' },        // 사용자 분산
    rooms: { _id: 'hashed' },        // 채팅방 분산  
    messages: { roomId: 1, _id: 1 }  // 메시지는 방별 분산
  },
  
  // ⚡ 극한 성능 옵션
  options: {
    maxPoolSize: 50,              // 각 샤드당 50개 연결
    minPoolSize: 20,              // 최소 20개 유지
    maxIdleTimeMS: 5000,          // 5초 후 해제
    serverSelectionTimeoutMS: 500, // 0.5초 서버 선택
    socketTimeoutMS: 10000,       // 10초 소켓 타임아웃
    connectTimeoutMS: 2000,       // 2초 연결 타임아웃
    // 🚀 읽기 최적화
    readPreference: 'secondaryPreferred',
    readConcern: { level: 'local' },
    writeConcern: { w: 1, j: false } // 빠른 쓰기
  }
};

// 🔴 Redis 클러스터 설정 (6개 인스턴스)
const redisCluster = {
  // 🔥 클러스터 노드 구성 (3 마스터 + 3 슬레이브)
  nodes: [
    // 마스터 노드들
    { host: 'redis01', port: 6379, role: 'master' },
    { host: 'redis02', port: 6379, role: 'master' },
    { host: 'redis03', port: 6379, role: 'master' },
    // 슬레이브 노드들  
    { host: 'redis04', port: 6379, role: 'slave', masterOf: 'redis01' },
    { host: 'redis05', port: 6379, role: 'slave', masterOf: 'redis02' },
    { host: 'redis06', port: 6379, role: 'slave', masterOf: 'redis03' }
  ],
  
  // ⚡ 극한 성능 설정
  options: {
    enableReadyCheck: false,        // 준비 체크 비활성화
    maxRetriesPerRequest: 1,        // 1번만 재시도
    retryDelayOnFailover: 10,       // 10ms 재시도 지연
    enableOfflineQueue: false,      // 오프라인 큐 비활성화
    lazyConnect: true,              // 지연 연결
    keepAlive: 30000,              // 30초 Keep-Alive
    connectTimeout: 1000,          // 1초 연결 타임아웃
    commandTimeout: 2000,          // 2초 명령 타임아웃
    // 🔥 읽기/쓰기 분산
    scaleReads: 'slave',           // 슬레이브에서 읽기
    maxRedirections: 3,            // 최대 3번 리다이렉션
    // 메모리 최적화
    db: 0,
    family: 4,                     // IPv4 사용
    password: process.env.REDIS_PASSWORD
  },
  
  // 📊 데이터 분산 전략
  dataDistribution: {
    sessions: 'redis01',           // 세션 데이터
    cache: 'redis02',              // 캐시 데이터
    realtime: 'redis03',           // 실시간 데이터
    queue: 'redis01',              // 큐 데이터
    analytics: 'redis02',          // 분석 데이터
    temp: 'redis03'                // 임시 데이터
  }
};

// 🎯 연결 풀 관리자
class DatabaseClusterManager {
  constructor() {
    this.mongoConnections = new Map();
    this.redisConnections = new Map();
  }
  
  // MongoDB 연결 풀 최적화
  async optimizeMongoPool() {
    for (const shard of mongoCluster.shards) {
      const connection = await mongoose.createConnection(
        `mongodb://${shard.servers.join(',')}/chat?replicaSet=${shard.name}`,
        mongoCluster.options
      );
      this.mongoConnections.set(shard.name, connection);
    }
  }
  
  // Redis 클러스터 연결
  async optimizeRedisCluster() {
    const Redis = require('ioredis');
    const cluster = new Redis.Cluster(
      redisCluster.nodes.map(node => ({ host: node.host, port: node.port })),
      { redisOptions: redisCluster.options }
    );
    this.redisConnections.set('cluster', cluster);
  }
}

module.exports = {
  mongoCluster,
  redisCluster,
  DatabaseClusterManager
}; 