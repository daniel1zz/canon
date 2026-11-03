# System Design Reference

## Quick Decision Table

| Concern | Options | When to Use |
|---------|---------|-------------|
| Scaling | Vertical → Horizontal | Vertical first, horizontal when limits hit |
| DB scaling | Read replicas → Sharding | Replicas for read-heavy, sharding for write-heavy |
| Consistency | Strong / Eventual / Causal | Finance=strong, social=eventual, collab=causal |
| Cache strategy | Cache-aside / Write-through / Write-behind / Read-through | Cache-aside most common |
| Cache level | Browser → CDN → App (Redis) → DB | Layer by access pattern |
| Queue | RabbitMQ / Kafka / SQS / Redis Streams | See selection below |

## Message Queue Selection

| System | Best For |
|--------|----------|
| RabbitMQ | Complex routing, message acknowledgment, flexible patterns |
| Kafka | High throughput, event sourcing, stream processing, replay |
| SQS | Simple queuing, serverless, managed infrastructure |
| Redis Streams | Low latency, already using Redis |

## Reliability Patterns (Keywords)

- **Circuit breaker**: CLOSED→OPEN→HALF_OPEN, prevent cascade failures
- **Retry**: Exponential backoff + jitter, prevent thundering herd
- **Bulkhead**: Thread/semaphore/queue isolation per service
- **Redundancy**: Active-active (stateless), active-passive (DBs)
- **Multi-AZ**: Survive AZ failure, same region latency

## Distributed Transactions

- **2PC**: All-or-nothing, blocking if coordinator fails
- **Saga (choreography)**: Services react to events, compensate on failure
- **Saga (orchestration)**: Central coordinator directs flow + compensations

## Back-of-Envelope Numbers

```
Powers of 2: 10=1K, 20=1M, 30=1G, 40=1T
Day = ~100k seconds, Year = ~31M seconds

Latency: L1=1ns, RAM=100ns, SSD=100μs, HDD=10ms
Network: same DC=500μs, cross-continent=150ms

Rule of thumb per server:
  QPS: 1k-10k, Connections: 10k-50k, Storage: 1-10TB
```

## Checklist

- [ ] Horizontal scaling possible, services stateless
- [ ] No single points of failure
- [ ] Health checks and monitoring
- [ ] Circuit breakers + retry with backoff
- [ ] Consistency model chosen
- [ ] CDN for static content
- [ ] Database indexes + connection pooling
- [ ] Async processing for heavy tasks
