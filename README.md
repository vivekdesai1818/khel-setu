# khel-setu
khel setu - grassroot sports talent discovery platform
# KhelSetu — Full-stack prototype
Live on : https://khel-setu-1.onrender.com/

A responsive sports discovery and support platform for grassroots athletes, scouts, coaches and supporters. Built with plain HTML/CSS/JavaScript and an Express + SQLite backend.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:5000`. API health check: `http://localhost:5000/api/health`.

## Main workflows

- Role-specific registration and login (athlete, scout, coach, donor/supporter)
- Persistent profile updates and JWT sessions
- Athlete leaderboard based on passbook points
- Scout discovery filters and trial invitations
- Coach feedback, ratings, point awards and passbook records
- Athlete support requests and supporter pledges (no payment processing)
- Training video links and local video uploads
- Community posts and comments
- Direct messages saved to SQLite

## Data and configuration

SQLite data is stored in `khelsetu.sqlite`; uploads are stored in `uploads/`. Copy `.env.example` to `.env` and set a strong `JWT_SECRET` before any deployment beyond local development.

## Prototype boundaries

School approval, payment processing, live notifications, production-grade moderation, rate limiting and production deployment hardening are not included. This project should be treated as a local prototype, not a public production service.

## October 2026 prototype additions
- School and Sports Administrator approval workflows
- Fixed local demo authority credentials (documented in `README-HINDI.txt`)
- Judge-only tournament result submission, level-weighted points, limited 0–5 performance bonus, observer reviews and optional certificate upload
- Sport-aware compact leaderboard and detailed athlete profile/history views
- Role-specific accent colours

This is a presentation prototype, not a production government system. Change demo credentials and complete security/privacy hardening before public deployment.
