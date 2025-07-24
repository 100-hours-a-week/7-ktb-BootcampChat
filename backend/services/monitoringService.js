const os = require('os');
const cacheService = require('./cacheService');
const dbOptimizationService = require('./dbOptimizationService');

class MonitoringService {
  constructor() {
    this.metrics = {
      requests: new Map(),
      responses: new Map(),
      errors: new Map(),
      socketConnections: 0,
      activeUsers: new Set(),
      roomActivity: new Map()
    };

    this.startTime = Date.now();
    this.isMonitoring = false;
  }

  // 모니터링 시작
  startMonitoring() {
    if (this.isMonitoring) {
      console.log('⚠️  모니터링이 이미 실행 중입니다.');
      return;
    }

    console.log('📈 모니터링 시스템 시작...');
    this.setupMetricsCollection();
    this.isMonitoring = true;
    console.log('✅ 모니터링 시스템 시작 완료');
  }

  // 모니터링 중지
  stopMonitoring() {
    console.log('📈 모니터링 시스템 중지...');
    this.isMonitoring = false;
    console.log('✅ 모니터링 시스템 중지 완료');
  }

  // 메트릭 수집 시작
  setupMetricsCollection() {
    // 5분마다 시스템 메트릭 수집
    setInterval(() => {
      this.collectSystemMetrics();
    }, 5 * 60 * 1000);

    // 1분마다 애플리케이션 메트릭 수집
    setInterval(() => {
      this.collectAppMetrics();
    }, 60 * 1000);

    // 10분마다 데이터베이스 메트릭 수집
    setInterval(() => {
      this.collectDatabaseMetrics();
    }, 10 * 60 * 1000);
  }

  // HTTP 요청 추적 미들웨어
  getRequestTracker() {
    return (req, res, next) => {
      const startTime = Date.now();
      const route = `${req.method} ${req.route?.path || req.path}`;

      // 요청 카운트
      const requestCount = this.metrics.requests.get(route) || 0;
      this.metrics.requests.set(route, requestCount + 1);

      // 응답 시간 측정
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        const responseKey = `${route}:${res.statusCode}`;
        
        if (!this.metrics.responses.has(responseKey)) {
          this.metrics.responses.set(responseKey, []);
        }
        
        this.metrics.responses.get(responseKey).push(duration);

        // 느린 요청 감지 (2초 이상)
        if (duration > 2000) {
          console.warn(`🐌 Slow request detected: ${route} took ${duration}ms`);
          this.logSlowRequest(req, res, duration);
        }

        // 에러 추적
        if (res.statusCode >= 400) {
          const errorCount = this.metrics.errors.get(responseKey) || 0;
          this.metrics.errors.set(responseKey, errorCount + 1);
        }
      });

      next();
    };
  }

  // 느린 요청 로깅
  async logSlowRequest(req, res, duration) {
    const logData = {
      method: req.method,
      url: req.originalUrl,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      userId: req.user?.id,
      duration,
      timestamp: new Date(),
      statusCode: res.statusCode
    };

    await cacheService.cacheStats(`slow_request:${Date.now()}`, logData, 24 * 60 * 60);
  }

  // 시스템 메트릭 수집
  async collectSystemMetrics() {
    const metrics = {
      timestamp: new Date(),
      cpu: {
        usage: os.loadavg(),
        cores: os.cpus().length
      },
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
        process: process.memoryUsage()
      },
      uptime: {
        system: os.uptime(),
        process: process.uptime()
      },
      network: os.networkInterfaces()
    };

    await cacheService.cacheStats('system_metrics', metrics, 300); // 5분 캐시
    
    // 메모리 사용량이 80% 이상이면 경고
    const memoryUsage = (metrics.memory.used / metrics.memory.total) * 100;
    if (memoryUsage > 80) {
      console.warn(`⚠️ High memory usage: ${memoryUsage.toFixed(2)}%`);
      await this.sendAlert('HIGH_MEMORY_USAGE', { usage: memoryUsage });
    }

    return metrics;
  }

  // 애플리케이션 메트릭 수집
  async collectAppMetrics() {
    const metrics = {
      timestamp: new Date(),
      requests: {
        total: Array.from(this.metrics.requests.values()).reduce((a, b) => a + b, 0),
        byRoute: Object.fromEntries(this.metrics.requests)
      },
      responses: {
        averageTime: this.calculateAverageResponseTime(),
        byStatusCode: this.groupResponsesByStatus()
      },
      errors: {
        total: Array.from(this.metrics.errors.values()).reduce((a, b) => a + b, 0),
        byType: Object.fromEntries(this.metrics.errors)
      },
      connections: {
        socket: this.metrics.socketConnections,
        activeUsers: this.metrics.activeUsers.size
      },
      rooms: {
        active: this.metrics.roomActivity.size,
        totalActivity: Array.from(this.metrics.roomActivity.values()).reduce((a, b) => a + b, 0)
      }
    };

    await cacheService.cacheStats('app_metrics', metrics, 60); // 1분 캐시

    // 에러율이 5% 이상이면 경고
    const errorRate = (metrics.errors.total / metrics.requests.total) * 100;
    if (errorRate > 5) {
      console.warn(`⚠️ High error rate: ${errorRate.toFixed(2)}%`);
      await this.sendAlert('HIGH_ERROR_RATE', { rate: errorRate });
    }

    return metrics;
  }

  // 데이터베이스 메트릭 수집
  async collectDatabaseMetrics() {
    try {
      const dbStats = await dbOptimizationService.getDBStats();
      const memoryUsage = dbOptimizationService.getMemoryUsage();

      const metrics = {
        timestamp: new Date(),
        database: dbStats,
        memory: memoryUsage
      };

      await cacheService.cacheStats('db_metrics', metrics, 600); // 10분 캐시
      return metrics;
    } catch (error) {
      console.error('Failed to collect database metrics:', error);
      return null;
    }
  }

  // 평균 응답 시간 계산
  calculateAverageResponseTime() {
    const allTimes = [];
    for (const times of this.metrics.responses.values()) {
      allTimes.push(...times);
    }
    
    if (allTimes.length === 0) return 0;
    return allTimes.reduce((a, b) => a + b, 0) / allTimes.length;
  }

  // 상태 코드별 응답 그룹화
  groupResponsesByStatus() {
    const grouped = {
      '2xx': 0,
      '3xx': 0,
      '4xx': 0,
      '5xx': 0
    };

    for (const [key, times] of this.metrics.responses) {
      const statusCode = key.split(':')[1];
      const category = `${Math.floor(statusCode / 100)}xx`;
      if (grouped[category] !== undefined) {
        grouped[category] += times.length;
      }
    }

    return grouped;
  }

  // Socket.IO 연결 추적
  trackSocketConnection(socketId, userId) {
    this.metrics.socketConnections++;
    if (userId) {
      this.metrics.activeUsers.add(userId);
    }
    
    console.log(`📡 Socket connected: ${socketId}, Active connections: ${this.metrics.socketConnections}`);
  }

  trackSocketDisconnection(socketId, userId) {
    this.metrics.socketConnections = Math.max(0, this.metrics.socketConnections - 1);
    if (userId) {
      this.metrics.activeUsers.delete(userId);
    }
    
    console.log(`📡 Socket disconnected: ${socketId}, Active connections: ${this.metrics.socketConnections}`);
  }

  // 채팅방 활동 추적
  trackRoomActivity(roomId) {
    const current = this.metrics.roomActivity.get(roomId) || 0;
    this.metrics.roomActivity.set(roomId, current + 1);
  }

  // 실시간 대시보드 데이터
  async getDashboardData() {
    const [systemMetrics, appMetrics, dbMetrics] = await Promise.all([
      cacheService.getStats('system_metrics'),
      cacheService.getStats('app_metrics'),
      cacheService.getStats('db_metrics')
    ]);

    return {
      timestamp: new Date(),
      system: systemMetrics,
      application: appMetrics,
      database: dbMetrics,
      realtime: {
        connections: this.metrics.socketConnections,
        activeUsers: this.metrics.activeUsers.size,
        activeRooms: this.metrics.roomActivity.size
      }
    };
  }

  // 성능 보고서 생성
  async generatePerformanceReport(timeRange = '1h') {
    const endTime = Date.now();
    const startTime = endTime - this.parseTimeRange(timeRange);

    // 시간대별 메트릭 수집 (실제 구현에서는 시계열 데이터베이스 사용)
    const report = {
      period: {
        start: new Date(startTime),
        end: new Date(endTime),
        duration: timeRange
      },
      summary: {
        totalRequests: Array.from(this.metrics.requests.values()).reduce((a, b) => a + b, 0),
        averageResponseTime: this.calculateAverageResponseTime(),
        errorRate: this.calculateErrorRate(),
        peakConnections: this.metrics.socketConnections,
        activeUsers: this.metrics.activeUsers.size
      },
      trends: await this.calculateTrends(),
      recommendations: this.generateRecommendations()
    };

    return report;
  }

  // 시간 범위 파싱
  parseTimeRange(range) {
    const units = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };

    const match = range.match(/(\d+)([mhd])/);
    if (!match) return 60 * 60 * 1000; // 기본 1시간

    return parseInt(match[1]) * units[match[2]];
  }

  // 에러율 계산
  calculateErrorRate() {
    const totalRequests = Array.from(this.metrics.requests.values()).reduce((a, b) => a + b, 0);
    const totalErrors = Array.from(this.metrics.errors.values()).reduce((a, b) => a + b, 0);
    
    return totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
  }

  // 트렌드 분석
  async calculateTrends() {
    // 실제 구현에서는 시계열 데이터 분석
    return {
      requestTrend: 'stable',
      responseTrend: 'improving',
      errorTrend: 'decreasing',
      userGrowth: 'increasing'
    };
  }

  // 성능 개선 추천사항 생성
  generateRecommendations() {
    const recommendations = [];
    
    const avgResponseTime = this.calculateAverageResponseTime();
    if (avgResponseTime > 1000) {
      recommendations.push({
        type: 'performance',
        priority: 'high',
        message: '평균 응답 시간이 1초를 초과합니다. 데이터베이스 쿼리 최적화를 검토하세요.',
        action: 'optimize_queries'
      });
    }

    const errorRate = this.calculateErrorRate();
    if (errorRate > 2) {
      recommendations.push({
        type: 'reliability',
        priority: 'medium',
        message: `에러율이 ${errorRate.toFixed(2)}%입니다. 에러 로그를 확인하세요.`,
        action: 'check_error_logs'
      });
    }

    if (this.metrics.socketConnections > 1000) {
      recommendations.push({
        type: 'scalability',
        priority: 'medium',
        message: 'WebSocket 연결이 1000개를 초과했습니다. 스케일링을 고려하세요.',
        action: 'consider_scaling'
      });
    }

    return recommendations;
  }

  // 알림 전송
  async sendAlert(type, data) {
    const alert = {
      type,
      data,
      timestamp: new Date(),
      severity: this.getAlertSeverity(type)
    };

    // Redis에 알림 저장
    await cacheService.cacheStats(`alert:${type}:${Date.now()}`, alert, 24 * 60 * 60);
    
    // 실제 구현에서는 외부 알림 서비스 연동
    console.log(`🚨 Alert: ${type}`, data);
  }

  // 알림 심각도 결정
  getAlertSeverity(type) {
    const severityMap = {
      'HIGH_MEMORY_USAGE': 'warning',
      'HIGH_ERROR_RATE': 'critical',
      'DATABASE_SLOW': 'warning',
      'HIGH_CONNECTIONS': 'info'
    };

    return severityMap[type] || 'info';
  }

  // 메트릭 초기화 (테스트용)
  resetMetrics() {
    this.metrics.requests.clear();
    this.metrics.responses.clear();
    this.metrics.errors.clear();
    this.metrics.activeUsers.clear();
    this.metrics.roomActivity.clear();
    this.metrics.socketConnections = 0;
  }

  // 헬스체크
  async getHealthStatus() {
    const systemMetrics = await this.collectSystemMetrics();
    const memoryUsage = (systemMetrics.memory.used / systemMetrics.memory.total) * 100;
    
    return {
      status: memoryUsage > 90 ? 'unhealthy' : memoryUsage > 80 ? 'degraded' : 'healthy',
      timestamp: new Date(),
      uptime: process.uptime(),
      memory: {
        usage: memoryUsage,
        total: systemMetrics.memory.total,
        free: systemMetrics.memory.free
      },
      connections: this.metrics.socketConnections,
      activeUsers: this.metrics.activeUsers.size
    };
  }
}

module.exports = new MonitoringService(); 