// 🔴 Redis 6개 인스턴스 용도별 분산 설정 (클러스터 X)
const redisInstances = {
  // 🎯 용도별 Redis 인스턴스 분산
  instances: {
    // 세션 & 인증 전용
    session: {
      host: 'redis01.internal',
      port: 6379,
      db: 0,
      password: process.env.REDIS_PASSWORD,
      purpose: '사용자 세션, JWT 토큰, 로그인 상태'
    },
    
    // 캐시 전용 (가장 많이 사용)
    cache: {
      host: 'redis02.internal', 
      port: 6379,
      db: 0,
      password: process.env.REDIS_PASSWORD,
      purpose: '채팅방 목록, 사용자 프로필, API 응답 캐시'
    },
    
    // 실시간 데이터 전용
    realtime: {
      host: 'redis03.internal',
      port: 6379, 
      db: 0,
      password: process.env.REDIS_PASSWORD,
      purpose: 'Socket.IO 데이터, 온라인 사용자, 실시간 알림'
    },
    
    // 메시지 큐 전용
    queue: {
      host: 'redis04.internal',
      port: 6379,
      db: 0, 
      password: process.env.REDIS_PASSWORD,
      purpose: 'Bull Queue, 비동기 작업, 이메일 큐'
    },
    
    // 통계 & 분석 전용
    analytics: {
      host: 'redis05.internal',
      port: 6379,
      db: 0,
      password: process.env.REDIS_PASSWORD, 
      purpose: '사용자 통계, 채팅방 활동, 성능 메트릭'
    },
    
    // 임시 데이터 전용
    temp: {
      host: 'redis06.internal',
      port: 6379,
      db: 0,
      password: process.env.REDIS_PASSWORD,
      purpose: '임시 파일, 업로드 상태, 단기 캐시'
    }
  },
  
  // ⚡ 각 인스턴스별 최적화 설정
  commonOptions: {
    connectTimeout: 1000,        // 1초 연결 타임아웃
    commandTimeout: 2000,        // 2초 명령 타임아웃
    retryDelayOnFailover: 10,    // 10ms 재시도
    maxRetriesPerRequest: 2,     // 2번 재시도
    lazyConnect: true,           // 지연 연결
    keepAlive: 30000,           // 30초 Keep-Alive
    family: 4,                  // IPv4
    enableReadyCheck: false,     // 준비 체크 비활성화
    maxLoadingTimeout: 2000     // 2초 로딩 타임아웃
  }
};

// 🎯 Redis 연결 관리자 (단순화)
class SimpleRedisManager {
  constructor() {
    this.connections = new Map();
    this.Redis = require('ioredis');
  }
  
  // 모든 Redis 인스턴스 연결
  async connectAll() {
    console.log('🔴 Redis 인스턴스 연결 시작...');
    
    for (const [name, config] of Object.entries(redisInstances.instances)) {
      try {
        const redis = new this.Redis({
          ...config,
          ...redisInstances.commonOptions
        });
        
        // 연결 이벤트 처리
        redis.on('connect', () => {
          console.log(`✅ Redis ${name} 연결됨 (${config.host})`);
        });
        
        redis.on('error', (err) => {
          console.error(`❌ Redis ${name} 오류:`, err.message);
        });
        
        this.connections.set(name, redis);
        
      } catch (error) {
        console.error(`❌ Redis ${name} 연결 실패:`, error.message);
      }
    }
    
    console.log('🎉 모든 Redis 인스턴스 연결 완료!');
  }
  
  // 용도별 Redis 인스턴스 가져오기
  getRedis(purpose) {
    return this.connections.get(purpose);
  }
  
  // 세션 Redis
  getSessionRedis() {
    return this.connections.get('session');
  }
  
  // 캐시 Redis (가장 많이 사용)
  getCacheRedis() {
    return this.connections.get('cache');
  }
  
  // 실시간 Redis
  getRealtimeRedis() {
    return this.connections.get('realtime');
  }
  
  // 큐 Redis
  getQueueRedis() {
    return this.connections.get('queue');
  }
  
  // 분석 Redis
  getAnalyticsRedis() {
    return this.connections.get('analytics');
  }
  
  // 임시 Redis
  getTempRedis() {
    return this.connections.get('temp');
  }
  
  // 모든 연결 종료
  async disconnectAll() {
    console.log('🔴 Redis 연결 종료 중...');
    
    for (const [name, redis] of this.connections) {
      try {
        await redis.quit();
        console.log(`✅ Redis ${name} 연결 종료됨`);
      } catch (error) {
        console.error(`❌ Redis ${name} 종료 실패:`, error.message);
      }
    }
    
    this.connections.clear();
    console.log('🎉 모든 Redis 연결 종료 완료!');
  }
}

// 🎯 용도별 Redis 사용 예시
const redisUsageExamples = {
  // 세션 저장
  async saveSession(userId, sessionData) {
    const sessionRedis = redisManager.getSessionRedis();
    await sessionRedis.setex(`session:${userId}`, 3600, JSON.stringify(sessionData));
  },
  
  // 채팅방 목록 캐시
  async cacheRoomList(rooms) {
    const cacheRedis = redisManager.getCacheRedis();
    await cacheRedis.setex('rooms:list', 300, JSON.stringify(rooms));
  },
  
  // 온라인 사용자 관리
  async setUserOnline(userId) {
    const realtimeRedis = redisManager.getRealtimeRedis();
    await realtimeRedis.sadd('online:users', userId);
  },
  
  // 큐에 작업 추가
  async addToQueue(jobData) {
    const queueRedis = redisManager.getQueueRedis();
    await queueRedis.lpush('jobs:queue', JSON.stringify(jobData));
  },
  
  // 통계 증가
  async incrementStat(statName) {
    const analyticsRedis = redisManager.getAnalyticsRedis();
    await analyticsRedis.incr(`stats:${statName}`);
  },
  
  // 임시 데이터 저장
  async saveTempData(key, data, ttl = 60) {
    const tempRedis = redisManager.getTempRedis();
    await tempRedis.setex(`temp:${key}`, ttl, JSON.stringify(data));
  }
};

// 글로벌 Redis 매니저 인스턴스
const redisManager = new SimpleRedisManager();

module.exports = {
  redisInstances,
  SimpleRedisManager,
  redisManager,
  redisUsageExamples
}; 