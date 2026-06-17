## Retry policy: the tradeoff

We have three places to absorb a transient failure. Pushing retries **down the
stack** trades latency for delivery guarantees.

| Layer  | Retries | Cost of a retry        | Guarantee       |
| ------ | :-----: | ---------------------- | --------------- |
| Client |    ✗    | round-trip + user wait | best-effort     |
| API    |    ✗    | holds a connection     | none            |
| Queue  |    ✓    | a few ms               | at-least-once   |
| Worker |    ✓    | backoff window         | eventually-once |

### The decision

Retry at the **worker**, not the edge. The client gets a fast `202` and a job
id; durability becomes the queue's problem, not the user's.

```ts
// jittered exponential backoff — the heart of the policy
const delay = (attempt: number) =>
  Math.min(MAX_MS, BASE_MS * 2 ** attempt) * (0.5 + Math.random() / 2);
```

> Full jitter matters more than the base: it's what stops a thundering herd of
> synchronized retries from knocking the worker over a second time.

This is a **markdown** part — handed over as _text_, not markup. The viewer owns
the typography, so tables, blockquotes, and fenced code all come out consistent
with the rest of the board.
