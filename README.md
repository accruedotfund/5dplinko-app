# 5dplinko.app

Multiplayer physics Plinko — ProofFront renderer + ProofNetwork contract.

| | |
|--|--|
| **Site** | https://5dplinko.app |
| **Contract** | `0x2CwT8CXi1W1EJ4Kv` |
| **Physics** | Server-authoritative Rapier on ProofNetwork |
| **Client** | Pure GL renderer + netsync |

## Local

```bash
npx serve .
# open http://localhost:3000
```

## Deploy

```bash
npx vercel deploy --prod --yes
```

Drop / reset use unsigned writes against the shared contract (same FreeSol physics board).
