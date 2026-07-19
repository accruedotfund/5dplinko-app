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

<!-- hypertribe:sponsors:start -->
## Sponsors

[![5dplinko-app Sponsors](https://api.tribe.run/tokens/3H4HYRCTiwoh9MUCBSYGAwBGzBCd8oxq6n5F7f3KxTRP/sponsors.svg)](https://tribe.run/token/3H4HYRCTiwoh9MUCBSYGAwBGzBCd8oxq6n5F7f3KxTRP)

Become a sponsor on [Tribe.run](https://tribe.run/token/3H4HYRCTiwoh9MUCBSYGAwBGzBCd8oxq6n5F7f3KxTRP).
<!-- hypertribe:sponsors:end -->
