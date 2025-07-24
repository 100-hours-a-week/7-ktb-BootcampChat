const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redisClient = require('../utils/redisClient');

class AdvancedRateLimiter {
  constructor() {
    // RedisStore는 각 limiter마다 고유하게 생성
  }

  createRedisStore(prefix = 'rl') {
    return new RedisStore({
      sendCommand: (...args) => redisClient.client.sendCommand(args),
      prefix: `${prefix}:`,
    });
  }

  // API 전체에 대한 기본 제한
  getGlobalLimiter() {
    return rateLimit({
      store: this.createRedisStore('global'),
      windowMs: 15 * 60 * 1000, // 15분
      max: 1000, // 15분당 1000 요청
      message: {
        success: false,
        message: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.',
        retryAfter: 15 * 60
      },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => {
        // IP + User ID 조합으로 더 정교한 제한
        return req.user?.id ? `${req.ip}:${req.user.id}` : req.ip;
      }
    });
  }

  // 인증 관련 엄격한 제한
  getAuthLimiter() {
    return rateLimit({
      store: this.createRedisStore('auth'),
      windowMs: 15 * 60 * 1000, // 15분
      max: 10, // 15분당 10번의 로그인 시도
      message: {
        success: false,
        message: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.',
        retryAfter: 15 * 60
      },
      skipSuccessfulRequests: true, // 성공한 요청은 카운트하지 않음
      keyGenerator: (req) => `auth:${req.ip}`
    });
  }

  // 메시지 전송 제한
  getMessageLimiter() {
    return rateLimit({
      store: this.createRedisStore('message'),
      windowMs: 1 * 60 * 1000, // 1분
      max: 60, // 1분당 60개 메시지
      message: {
        success: false,
        message: '메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 시도해주세요.',
        retryAfter: 60
      },
      keyGenerator: (req) => `message:${req.user?.id || req.ip}`
    });
  }

  // 파일 업로드 제한
  getFileLimiter() {
    return rateLimit({
      store: this.createRedisStore('file'),
      windowMs: 10 * 60 * 1000, // 10분
      max: 20, // 10분당 20개 파일
      message: {
        success: false,
        message: '파일 업로드 한도를 초과했습니다. 잠시 후 다시 시도해주세요.',
        retryAfter: 10 * 60
      },
      keyGenerator: (req) => `upload:${req.user?.id || req.ip}`
    });
  }

  // 채팅방 생성 제한
  getRoomLimiter() {
    return rateLimit({
      store: this.createRedisStore('room'),
      windowMs: 60 * 60 * 1000, // 1시간
      max: 10, // 1시간당 10개 채팅방
      message: {
        success: false,
        message: '채팅방 생성 한도를 초과했습니다. 1시간 후 다시 시도해주세요.',
        retryAfter: 60 * 60
      },
      keyGenerator: (req) => `room:${req.user?.id || req.ip}`
    });
  }

  // AI 요청 제한 (비용 관리)
  getAILimiter() {
    return rateLimit({
      store: this.createRedisStore('ai'),
      windowMs: 10 * 60 * 1000, // 10분
      max: 30, // 10분당 30개 AI 요청
      message: {
        success: false,
        message: 'AI 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.',
        retryAfter: 10 * 60
      },
      keyGenerator: (req) => `ai:${req.user?.id || req.ip}`
    });
  }

  // 동적 Rate Limiting (사용자 레벨 기반)
  getDynamicLimiter() {
    return (req, res, next) => {
      const userLevel = req.user?.level || 'basic';
      const limits = {
        basic: { windowMs: 15 * 60 * 1000, max: 500 },
        premium: { windowMs: 15 * 60 * 1000, max: 2000 },
        admin: { windowMs: 15 * 60 * 1000, max: 10000 }
      };

      const limiter = rateLimit({
        store: this.createRedisStore('dynamic'),
        windowMs: limits[userLevel].windowMs,
        max: limits[userLevel].max,
        keyGenerator: (req) => `dynamic:${userLevel}:${req.user?.id || req.ip}`
      });

      return limiter(req, res, next);
    };
  }

  // IP 기반 의심스러운 활동 감지
  getSuspiciousActivityLimiter() {
    return rateLimit({
      store: this.createRedisStore('suspicious'),
      windowMs: 5 * 60 * 1000, // 5분
      max: 100, // 5분당 100 요청 (의심스러운 활동 임계값)
      message: {
        success: false,
        message: '의심스러운 활동이 감지되었습니다. 계정이 일시적으로 제한되었습니다.',
        retryAfter: 30 * 60 // 30분 제한
      },
      onLimitReached: (req, res, options) => {
        // 의심스러운 활동 로깅
        console.warn(`🚨 Suspicious activity detected from IP: ${req.ip}, User: ${req.user?.id}`);
        
        // 알림 시스템 연동 (예: Slack, 이메일 등)
        this.notifySecurityTeam({
          ip: req.ip,
          userId: req.user?.id,
          userAgent: req.get('User-Agent'),
          timestamp: new Date(),
          reason: 'Rate limit exceeded'
        });
      }
    });
  }

  // 보안팀 알림 (실제 구현에서는 외부 서비스 연동)
  async notifySecurityTeam(incident) {
    try {
      // Redis에 보안 이벤트 저장
      await redisClient.setEx(
        `security:incident:${Date.now()}`,
        24 * 60 * 60, // 24시간 보관
        JSON.stringify(incident)
      );

      // 실제 구현에서는 Slack, Discord, 이메일 등으로 알림
      console.log('🔔 Security incident logged:', incident);
    } catch (error) {
      console.error('Failed to log security incident:', error);
    }
  }

  // 헬스체크용 제한 (모니터링 도구용)
  getHealthCheckLimiter() {
    return rateLimit({
      store: this.createRedisStore('health'),
      windowMs: 1 * 60 * 1000, // 1분
      max: 60, // 1분당 60번 (모니터링 도구 고려)
      skip: (req) => {
        // 특정 IP나 User-Agent는 제외 (모니터링 도구)
        const allowedIPs = process.env.MONITORING_IPS?.split(',') || [];
        return allowedIPs.includes(req.ip);
      }
    });
  }

  // WebSocket 연결 제한
  getSocketConnectionLimiter() {
    const connectionCounts = new Map();

    return (socket, next) => {
      const ip = socket.handshake.address;
      const currentCount = connectionCounts.get(ip) || 0;
      
      if (currentCount >= 10) { // IP당 최대 10개 동시 연결
        console.warn(`🚨 Too many socket connections from IP: ${ip}`);
        return next(new Error('Too many connections from this IP'));
      }

      connectionCounts.set(ip, currentCount + 1);

      socket.on('disconnect', () => {
        const count = connectionCounts.get(ip) || 0;
        if (count <= 1) {
          connectionCounts.delete(ip);
        } else {
          connectionCounts.set(ip, count - 1);
        }
      });

      next();
    };
  }

  // Rate Limit 상태 조회 API
  async getRateLimitStatus(key) {
    try {
      const hits = await redisClient.get(`rl:${key}`);
      const ttl = await redisClient.client.ttl(`rl:${key}`);
      
      return {
        hits: hits ? parseInt(hits) : 0,
        remaining: Math.max(0, 1000 - (hits ? parseInt(hits) : 0)),
        resetTime: ttl > 0 ? new Date(Date.now() + ttl * 1000) : null
      };
    } catch (error) {
      console.error('Error getting rate limit status:', error);
      return null;
    }
  }
}

module.exports = new AdvancedRateLimiter(); 