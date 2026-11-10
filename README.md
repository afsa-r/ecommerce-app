# E-Commerce App (Node.js + Express + PostgreSQL)

## Run it
1. Install Node 18+. Start PostgreSQL either with Docker (`docker compose up -d`) or locally (`createdb shop`).
2. Install dependencies: `npm install`
3. Start the server (tables and sample data are created automatically):
   `DATABASE_URL=postgres://USER:PASS@localhost:5432/shop JWT_SECRET=change-me npm start`
4. Open http://localhost:3000

Demo admin: `admin@shop.com` / `admin123` (change it). Anyone who registers gets the `user` role.

Tested end to end on Node 22 and PostgreSQL 16: registration, login, role checks, checkout with stock rollback, order status updates and the admin panel.

## Structure
- `schema.sql`: users, products, orders, order_items
- `server.js`: REST API, JWT auth, role checks
- `public/index.html`: catalog, cart, checkout, login, orders, admin panel

## API
| Method | Route | Access |
|---|---|---|
| POST | /api/auth/register, /api/auth/login | public |
| GET | /api/products | public |
| POST / PUT / DELETE | /api/products[/:id] | admin |
| POST | /api/orders | logged-in user (transactional, checks stock, uses DB prices) |
| GET | /api/orders | user sees own, admin sees all |
| PATCH | /api/orders/:id/status | admin |

## Next steps
Payments (Stripe), product images, pagination, input validation library, tests, HTTPS and a strong `JWT_SECRET` before deploying.
