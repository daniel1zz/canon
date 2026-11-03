# Architecture Patterns Reference

## Pattern Selection

| Pattern | When | Key Rule |
|---------|------|----------|
| Layered (3-tier) | Standard web apps | Presentation→Business→Data, never skip layers |
| Clean Architecture | Complex domain logic | Dependencies point inward, domain isolated |
| Microservices | Large teams, independent deploy | One service = one business capability, own DB |
| Event-Driven | Decoupling, async workflows | Idempotent handlers, outbox for reliability |

## Clean Architecture Folder Structure

```
src/
├── domain/           # Entities, Value Objects (innermost, no deps)
├── application/      # Use Cases, Ports (interfaces)
├── infrastructure/   # Repository impls, external services
└── presentation/     # HTTP controllers, GraphQL resolvers
```

**Key rule**: Inner layers never import from outer layers. Use ports (interfaces) in application/, implementations in infrastructure/.

## Microservices Key Rules

- One service = one business capability, own database
- No shared databases
- Sync (REST/gRPC) for strong consistency, async (events) for decoupling
- API Gateway for routing, auth, rate limiting, aggregation

## Event-Driven Key Patterns

### Outbox Pattern (Dual-Write Safety)
1. Write to DB + outbox table in **same transaction**
2. Background worker reads outbox, publishes to broker
3. Mark events as published

### Event Schema
```typescript
interface DomainEvent {
  eventId: string;
  eventType: string;       // Past tense: OrderPlaced, UserRegistered
  aggregateId: string;
  timestamp: Date;
  version: number;
  payload: unknown;
  metadata: { correlationId: string; causationId: string; userId?: string };
}
```

## DDD Quick Reference

| Concept | Rule |
|---------|------|
| Bounded Context | Same term, different meaning across contexts |
| Entity | Has identity, behavior over data |
| Value Object | No identity, immutable, validated on creation |
| Aggregate | Consistency boundary, access only through root |
| Domain Service | Logic spanning multiple entities |
| Repository | Persistence abstraction per aggregate |
| Anti-corruption Layer | Translate between bounded contexts |

## Checklist

- [ ] Architecture pattern chosen and justified
- [ ] Layer responsibilities clear, dependencies flow inward
- [ ] Domain logic isolated from infrastructure
- [ ] For microservices: service boundaries = business capabilities, own DB each
- [ ] For event-driven: outbox pattern, idempotent handlers, dead letter queue
- [ ] Event schema versioning planned
