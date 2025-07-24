// 🚀 30개 t3.small 인스턴스 극한 성능 설정
module.exports = {
  // 🖥️ 백엔드 서버 설정 (15개 인스턴스)
  backend: {
    // 각 t3.small당 최적화 (2GB RAM, 2 vCPU)
    nodeOptions: {
      UV_THREADPOOL_SIZE: 32,  // 2 vCPU × 16
      NODE_OPTIONS: '--max-old-space-size=1536' // 1.5GB 할당 (여유분 확보)
    },
    
    // MongoDB 연결 (6개 DB 인스턴스 분산)
    mongoOptions: {
      maxPoolSize: 30,         // 각 백엔드당 30개 연결
      minPoolSize: 10,         // 최소 10개 유지
      maxIdleTimeMS: 10000,    // 빠른 연결 회전
      serverSelectionTimeoutMS: 1000,
      socketTimeoutMS: 15000,
      connectTimeoutMS: 3000,
      maxConnecting: 15,       // 동시 연결 시도
      // 🔥 분산 읽기 최적화
      readPreference: 'secondaryPreferred',
      readConcern: { level: 'local' }
    },
    
    // 서버 성능 극대화
    serverOptions: {
      keepAliveTimeout: 20000,
      headersTimeout: 21000,
      timeout: 30000,          // 빠른 타임아웃
      maxConnections: 1000,    // 각 인스턴스당 1000개
      backlog: 511             // 최대 백로그
    }
  },
  
  // 🔴 Redis 클러스터 설정 (6개 인스턴스)
  redis: {
    cluster: {
      enableReadyCheck: false,
      redisOptions: {
        password: process.env.REDIS_PASSWORD
      },
      // 🚀 극한 성능 설정
      maxRetriesPerRequest: 1,    // 빠른 실패
      retryDelayOnFailover: 10,   // 10ms 재시도
      enableOfflineQueue: false,   // 오프라인 큐 비활성화
      lazyConnect: true,          // 지연 연결
      keepAlive: 30000,           // 30초 Keep-Alive
      connectTimeout: 1000,       // 1초 연결 타임아웃
      commandTimeout: 2000,       // 2초 명령 타임아웃
      // 🔥 분산 읽기
      scaleReads: 'slave'         // 슬레이브에서 읽기
    }
  },
  
  // 📊 예상 극한 성능
  expectedPerformance: {
    maxConcurrentUsers: 5000,    // 5천명 동시 접속
    avgResponseTime: '< 10ms',   // 10ms 이하
    successRate: '99.5%+',       // 99.5% 이상
    requestsPerSecond: 50000,    // 5만 req/sec
    throughput: '1GB/sec'        // 1GB/초 처리량
  }
}; 