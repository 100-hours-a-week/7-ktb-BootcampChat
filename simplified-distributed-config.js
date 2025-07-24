// 🚀 30개 t3.small 단순화된 분산 시스템 설정
module.exports = {
  // 🖥️ 백엔드 서버 (15개 인스턴스)
  backend: {
    instances: 15,
    perInstance: {
      // Node.js 최적화 (t3.small 2GB RAM, 2 vCPU)
      nodeOptions: {
        UV_THREADPOOL_SIZE: 32,
        NODE_OPTIONS: '--max-old-space-size=1536'
      },
      
      // MongoDB 연결 (6개 DB로 분산)
      mongoOptions: {
        maxPoolSize: 25,         // 각 백엔드당 25개 연결
        minPoolSize: 8,          // 최소 8개 유지
        maxIdleTimeMS: 15000,
        serverSelectionTimeoutMS: 2000,
        socketTimeoutMS: 20000,
        connectTimeoutMS: 5000
      },
      
      // 서버 설정
      serverOptions: {
        keepAliveTimeout: 20000,
        headersTimeout: 21000,
        timeout: 45000,
        maxConnections: 800,     // 각 인스턴스당 800개
        backlog: 511
      }
    }
  },
  
  // 🗄️ MongoDB (6개 인스턴스) - 샤딩 없이 복제만
  mongodb: {
    instances: 6,
    architecture: 'replica-set',  // 클러스터 X, 복제만
    replicaSets: [
      {
        name: 'primary-rs',
        members: ['mongodb01:27017', 'mongodb02:27017'],
        primary: 'mongodb01:27017'
      },
      {
        name: 'secondary-rs',
        members: ['mongodb03:27017', 'mongodb04:27017'], 
        primary: 'mongodb03:27017'
      },
      {
        name: 'analytics-rs',
        members: ['mongodb05:27017', 'mongodb06:27017'],
        primary: 'mongodb05:27017'
      }
    ],
    
    // 데이터 분산 전략 (수동)
    dataDistribution: {
      users: 'primary-rs',      // 사용자 데이터
      rooms: 'primary-rs',      // 채팅방 데이터
      messages: 'secondary-rs', // 메시지 데이터 (대용량)
      files: 'secondary-rs',    // 파일 메타데이터
      analytics: 'analytics-rs' // 통계 및 로그
    }
  },
  
  // 🔴 Redis (6개 인스턴스) - 용도별 단순 분산
  redis: {
    instances: 6,
    architecture: 'simple-distributed', // 클러스터 X
    distribution: {
      'redis01': 'session',    // 세션 & 인증
      'redis02': 'cache',      // 캐시 (가장 중요)
      'redis03': 'realtime',   // Socket.IO & 실시간
      'redis04': 'queue',      // 메시지 큐
      'redis05': 'analytics',  // 통계 & 모니터링
      'redis06': 'temp'        // 임시 데이터
    },
    
    perInstance: {
      maxmemory: '1400mb',     // t3.small 2GB의 70%
      maxmemoryPolicy: 'allkeys-lru',
      save: '',                // 디스크 저장 비활성화 (성능)
      tcpBacklog: 511,
      timeout: 0,
      tcpKeepalive: 300
    }
  },
  
  // 🌐 로드밸런서 (1개 인스턴스)
  loadBalancer: {
    type: 'haproxy',
    maxConnections: 50000,
    algorithm: 'roundrobin',
    healthCheck: '/api/health',
    stickySession: false,     // Socket.IO는 Redis로 동기화
    
    backends: [
      'backend01:5000', 'backend02:5000', 'backend03:5000',
      'backend04:5000', 'backend05:5000', 'backend06:5000',
      'backend07:5000', 'backend08:5000', 'backend09:5000',
      'backend10:5000', 'backend11:5000', 'backend12:5000',
      'backend13:5000', 'backend14:5000', 'backend15:5000'
    ]
  },
  
  // 📊 예상 성능 (단순화된 구조)
  expectedPerformance: {
    maxConcurrentUsers: 3000,    // 3천명 (클러스터 없어서 감소)
    avgResponseTime: '< 15ms',   // 15ms 이하
    successRate: '98%+',         // 98% 이상 (안정성 중시)
    requestsPerSecond: 30000,    // 3만 req/sec
    cpuUtilization: '70%',       // CPU 70% 활용
    memoryUtilization: '75%'     // 메모리 75% 활용
  },
  
  // 🔧 구현 우선순위
  implementationPriority: [
    '1. 로드밸런서 설정 (HAProxy)',
    '2. MongoDB 복제셋 구성', 
    '3. Redis 용도별 분산',
    '4. 백엔드 서버 최적화',
    '5. 모니터링 시스템',
    '6. 부하테스트 실행'
  ],
  
  // ✅ 장점 (클러스터 제거 후)
  advantages: [
    '설정이 단순하고 안정적',
    '디버깅과 모니터링이 쉬움', 
    '장애 포인트 감소',
    '빠른 배포 가능',
    '운영 복잡도 최소화'
  ],
  
  // ⚠️ 단점 (클러스터 제거 후)
  disadvantages: [
    '최대 성능은 클러스터보다 낮음',
    '데이터 분산이 수동적',
    '단일 Redis 인스턴스 장애 위험',
    'MongoDB 샤딩 없음'
  ]
}; 