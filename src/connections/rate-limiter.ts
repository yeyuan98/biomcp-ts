import { RateLimitConfig } from './base.js';

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private refillRate: number;
  
  constructor(
    private readonly config: RateLimitConfig,
    private readonly hasKey: boolean = false
  ) {
    this.capacity = 1;
    const effectiveMs = this.getEffectiveInterval();
    this.refillRate = 1 / effectiveMs;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
  
  private getEffectiveInterval(): number {
    if (this.config.conditional) {
      if (this.hasKey && this.config.keyedRateLimitMs) {
        return this.config.keyedRateLimitMs;
      }
      return this.config.fallbackRateLimitMs || this.config.intervalMs;
    }
    return this.config.intervalMs;
  }
  
  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      
      const waitMs = (1 - this.tokens) / this.refillRate;
      await this.sleep(waitMs);
    }
  }
  
  updateRateLimit(newConfig: RateLimitConfig, hasKey: boolean): void {
    const effectiveMs = newConfig.conditional
      ? (hasKey && newConfig.keyedRateLimitMs ? newConfig.keyedRateLimitMs : newConfig.fallbackRateLimitMs || newConfig.intervalMs)
      : newConfig.intervalMs;
    this.refillRate = 1 / effectiveMs;
  }
  
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return; // clock regression: no refill, never negative tokens
    
    const tokensToAdd = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class RateLimiterFactory {
  static create(
    config: RateLimitConfig,
    hasKey: boolean = false
  ): TokenBucketRateLimiter {
    return new TokenBucketRateLimiter(config, hasKey);
  }
  
  static getEffectiveRate(
    baseRate: number,
    config: RateLimitConfig,
    hasKey: boolean
  ): number {
    if (config.conditional) {
      return hasKey && config.keyedRateLimitMs
        ? config.keyedRateLimitMs
        : config.fallbackRateLimitMs || baseRate;
    }
    return baseRate;
  }
}