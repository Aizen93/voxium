import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { authRouter } from './routes/auth';
import { serverRouter } from './routes/servers';
import { channelRouter } from './routes/channels';
import { messageRouter } from './routes/messages';
import { userRouter } from './routes/users';
import { inviteRouter } from './routes/invites';
import { uploadRouter } from './routes/uploads';
import { dmRouter } from './routes/dm';
import { friendRouter } from './routes/friends';
import { errorHandler } from './middleware/errorHandler';
import { rateLimitGeneral } from './middleware/rateLimiter';

export const app = express();

// Enable trust proxy so req.ip reflects the real client IP behind reverse proxies
app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────────────────────

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:8080')
  .split(',')
  .map((o) => o.trim());

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', ...allowedOrigins],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'", ...allowedOrigins],
    },
  },
}));

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes ──────────────────────────────────────────────────────────────

const api = express.Router();
api.use(rateLimitGeneral);
api.use('/auth', authRouter);
api.use('/users', userRouter);
api.use('/servers', serverRouter);
api.use('/servers/:serverId/channels', channelRouter);
api.use('/channels/:channelId/messages', messageRouter);
api.use('/invites', inviteRouter);
api.use('/uploads', uploadRouter);
api.use('/dm', dmRouter);
api.use('/friends', friendRouter);

app.use('/api/v1', api);

// ─── Error Handler ───────────────────────────────────────────────────────────

app.use(errorHandler);
