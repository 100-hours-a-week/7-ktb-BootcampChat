class MemoryCache {
  constructor() {
    this.cache = new Map();
    this.timers = new Map();
    this.stats = { hits: 0, misses: 0, sets: 0 };
  }

  // 초고속 설정 (TTL 포함)
  set(key, value, ttlSeconds = 300) {
    // 기존 타이머 정리
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    // 값 저장
    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      ttl: ttlSeconds * 1000
    });

    // TTL 타이머 설정
    const timer = setTimeout(() => {
      this.cache.delete(key);
      this.timers.delete(key);
    }, ttlSeconds * 1000);

    this.timers.set(key, timer);
    this.stats.sets++;
    return true;
  }

  // 초고속 조회
  get(key) {
    const item = this.cache.get(key);
    
    if (!item) {
      this.stats.misses++;
      return null;
    }

    // TTL 체크
    if (Date.now() - item.createdAt > item.ttl) {
      this.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return item.value;
  }

  // 삭제
  delete(key) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    return this.cache.delete(key);
  }

  // 통계
  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
    };
  }

  // 전체 정리
  clear() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.cache.clear();
    this.timers.clear();
    this.stats = { hits: 0, misses: 0, sets: 0 };
  }

  // 만료된 항목 정리 (메모리 최적화)
  cleanup() {
    const now = Date.now();
    const toDelete = [];

    for (const [key, item] of this.cache.entries()) {
      if (now - item.createdAt > item.ttl) {
        toDelete.push(key);
      }
    }

    toDelete.forEach(key => this.delete(key));
    return toDelete.length;
  }
}

// 글로벌 인스턴스
const memoryCache = new MemoryCache();

// 5분마다 정리
setInterval(() => {
  const cleaned = memoryCache.cleanup();
  if (cleaned > 0) {
    console.log(`🧹 메모리 캐시 정리: ${cleaned}개 항목 삭제`);
  }
}, 5 * 60 * 1000);

module.exports = memoryCache; 