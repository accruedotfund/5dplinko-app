# 5dplinko.app

Multiplayer **pot Plinko** on ProofNetwork.

| | |
|--|--|
| **Contract** | `` |
| **Play** | Bet SOL → VRF bin → payout from shared pot |
| **Reserve** | Max-win liability tracked; refund if pot too thin |
| **Mults** | `[25, 8, 3, 1, 0.5, 1, 3, 8, 25]` |

## Local

```bash
npm start
# http://localhost:3000
```

## Deploy

```bash
npx vercel deploy --prod --yes
# attach domain 5dplinko.app
```

Contract source: `contract/plinko5d.js` in deploy history / ProofNetwork id 1266+.
