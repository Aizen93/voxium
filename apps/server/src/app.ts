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
import { errorHandler } from './middleware/errorHandler';

export const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:8080')
  .split(',')
  .map((o) => o.trim());

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes ──────────────────────────────────────────────────────────────

const api = express.Router();
api.use('/auth', authRouter);
api.use('/users', userRouter);
api.use('/servers', serverRouter);
api.use('/servers/:serverId/channels', channelRouter);
api.use('/channels/:channelId/messages', messageRouter);
api.use('/invites', inviteRouter);

app.use('/api/v1', api);

// ─── Error Handler ───────────────────────────────────────────────────────────

app.use(errorHandler);
