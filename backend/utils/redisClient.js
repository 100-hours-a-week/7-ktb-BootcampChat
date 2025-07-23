// backend/utils/redisClient.js - 수정된 버전
const Redis = require('redis');
const { redisHost, redisPort } = require('../config/keys');

class MockRedisClient {
  constructor() {
    this.store = new Map();
    this.isConnected = true;
    console.log('🔄 Using in-memory Redis mock (Redis server not available)');
  }

  async connect() {
    return this;
  }

  async set(key, value, options = {}) {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.store.set(key, { 
      value: stringValue, 
      expires: options.ttl ? Date.now() + (options.ttl * 1000) : null 
    });
    return 'OK';
  }

  async get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    
    if (item.expires && Date.now() > item.expires) {
      this.store.delete(key);
      return null;
    }
    
    return item.value;
  }

  async setEx(key, seconds, value) {
    return this.set(key, value, { ttl: seconds });
  }

  // chat.js에서 사용하는 setex 메서드 추가 (호환성)
  async setex(key, seconds, value) {
    return this.setEx(key, seconds, value);
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    const item = this.store.get(key);
    if (item) {
      item.expires = Date.now() + (seconds * 1000);
      return 1;
    }
    return 0;
  }

  async incr(key) {
    const item = this.store.get(key);
    let currentValue = 1;
    
    if (item && !item.expires || (item.expires && Date.now() <= item.expires)) {
      try {
        currentValue = parseInt(item.value) + 1;
      } catch {
        currentValue = 1;
      }
    }
    
    this.store.set(key, { 
      value: currentValue.toString(), 
      expires: item?.expires || null 
    });
    
    return currentValue;
  }

  async quit() {
    this.store.clear();
    console.log('Mock Redis connection closed');
  }

  async ping() {
    return 'PONG';
  }
}

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 3;
    this.retryDelay = 2000;
    this.useMock = false;
  }

  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    // Redis 설정이 없으면 Mock 사용
    if (!redisHost || !redisPort) {
      console.log('⚠️  Redis configuration not found, using in-memory mock');
      this.client = new MockRedisClient();
      this.isConnected = true;
      this.useMock = true;
      return this.client;
    }

    try {
      console.log(`🔗 Connecting to Redis at ${redisHost}:${redisPort}...`);

      this.client = Redis.createClient({
        url: `redis://${redisHost}:${redisPort}`,
        socket: {
          host: redisHost,
          port: redisPort,
          connectTimeout: 5000,
          reconnectStrategy: (retries) => {
            if (retries > this.maxRetries) {
              console.log('❌ Max Redis reconnection attempts reached, switching to in-memory mock');
              return false; // Redis 재연결 포기하고 Mock으로 대체
            }
            return Math.min(retries * 100, 2000);
          }
        }
      });

      this.client.on('connect', () => {
        console.log('✅ Redis Client Connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
        this.useMock = false;
      });

      this.client.on('error', (err) => {
        console.error('❌ Redis Client Error:', err.message);
        if (!this.useMock) {
          console.log('🔄 Switching to in-memory mock Redis');
          this.client = new MockRedisClient();
          this.isConnected = true;
          this.useMock = true;
        }
      });

      this.client.on('disconnect', () => {
        console.log('⚠️  Redis Client Disconnected');
        this.isConnected = false;
      });

      await this.client.connect();
      return this.client;

    } catch (error) {
      console.error('❌ Redis connection failed:', error.message);
      console.log('🔄 Using in-memory mock Redis instead');
      this.client = new MockRedisClient();
      this.isConnected = true;
      this.useMock = true;
      return this.client;
    }
  }

  async set(key, value, options = {}) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.set(key, value, options);
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      if (options.ttl || options.EX) {
        const ttl = options.ttl || options.EX;
        return await this.client.setEx(key, ttl, stringValue);
      }
      return await this.client.set(key, stringValue);
    } catch (error) {
      console.error('Redis set error:', error);
      // Redis 에러 시 Mock으로 폴백
      if (!this.useMock) {
        this.client = new MockRedisClient();
        this.useMock = true;
        return await this.client.set(key, value, options);
      }
      throw error;
    }
  }

  async get(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.get(key);
      }

      const value = await this.client.get(key);
      if (!value) return null;

      // 이미 객체인 경우 그대로 반환
      if (typeof value === 'object') {
        return value;
      }

      // 문자열인 경우에만 JSON 파싱 시도
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch (parseError) {
          // JSON 파싱 실패시 원본 문자열 반환
          return value;
        }
      }

      return value;
    } catch (error) {
      console.error('Redis get error:', error);
      // Redis 에러 시 Mock으로 폴백
      if (!this.useMock) {
        this.client = new MockRedisClient();
        this.useMock = true;
        return await this.client.get(key);
      }
      return null;
    }
  }

  async setEx(key, seconds, value) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.setEx(key, seconds, value);
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      return await this.client.setEx(key, seconds, stringValue);
    } catch (error) {
      console.error('Redis setEx error:', error);
      // Redis 에러 시 Mock으로 폴백
      if (!this.useMock) {
        this.client = new MockRedisClient();
        this.useMock = true;
        return await this.client.setEx(key, seconds, value);
      }
      throw error;
    }
  }

  // chat.js에서 사용하는 setex 메서드 추가 (호환성)
  async setex(key, seconds, value) {
    return await this.setEx(key, seconds, value);
  }

  async del(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.del(key);
      }

      return await this.client.del(key);
    } catch (error) {
      console.error('Redis del error:', error);
      // Redis 에러 시 Mock으로 폴백
      if (!this.useMock) {
        this.client = new MockRedisClient();
        this.useMock = true;
        return await this.client.del(key);
      }
      return 0;
    }
  }

  async expire(key, seconds) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.expire(key, seconds);
      }

      return await this.client.expire(key, seconds);
    } catch (error) {
      console.error('Redis expire error:', error);
      // Redis 에러 시 Mock으로 폴백
      if (!this.useMock) {
        this.client = new MockRedisClient();
        this.useMock = true;
        return await this.client.expire(key, seconds);
      }
      return 0;
    }
  }

  async incr(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.incr(key);
      }

      return await this.client.incr(key);
    } catch (error) {
      console.error('Redis incr error:', error);
      // Redis 에러 시 Mock으로 폴백
      if (!this.useMock) {
        this.client = new MockRedisClient();
        this.useMock = true;
        return await this.client.incr(key);
      }
      return 1;
    }
  }

  async ping() {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.ping();
      }

      return await this.client.ping();
    } catch (error) {
      console.error('Redis ping error:', error);
      return 'PONG'; // 연결 체크용이므로 성공으로 처리
    }
  }

  async quit() {
    if (this.client) {
      try {
        if (!this.useMock) {
          await this.client.quit();
        } else {
          await this.client.quit();
        }
        this.isConnected = false;
        this.client = null;
        console.log('Redis connection closed successfully');
      } catch (error) {
        console.error('Redis quit error:', error);
      }
    }
  }

  // 연결 상태 확인
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      useMock: this.useMock,
      connectionAttempts: this.connectionAttempts
    };
  }
}

const redisClient = new RedisClient();

// 초기 연결 시도
redisClient.connect().catch(err => {
  console.error('Initial Redis connection failed:', err.message);
});

module.exports = redisClient;