import { Router, type Request, type Response, type NextFunction } from 'express';
import { registerUser, loginUser, refreshTokens, requestPasswordReset, resetPassword, changePassword } from '../services/authService';
import { authenticate } from '../middleware/auth';
import { rateLimitRegister, rateLimitLogin, rateLimitForgotPassword, rateLimitResetPassword, rateLimitRefresh, rateLimitChangePassword } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';

export const authRouter = Router();

authRouter.post('/register', rateLimitRegister, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password, displayName } = req.body;
    const result = await registerUser(username, email, password, displayName);

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', rateLimitLogin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, rememberMe } = req.body;
    const ip = req.ip || req.socket.remoteAddress;
    const result = await loginUser(email, password, rememberMe ?? true, ip);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', rateLimitRefresh, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    const tokens = await refreshTokens(refreshToken);

    res.json({
      success: true,
      data: tokens,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        avatarUrl: true,
        bio: true,
        status: true,
        role: true,
        createdAt: true,
      },
    });

    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/forgot-password', rateLimitForgotPassword, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      res.status(400).json({ success: false, error: 'Email is required' });
      return;
    }
    await requestPasswordReset(email);
    res.json({ success: true, message: 'If an account with that email exists, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/reset-password', rateLimitResetPassword, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ success: false, error: 'Reset token is required' });
      return;
    }
    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Password is required' });
      return;
    }
    await resetPassword(token, password);
    res.json({ success: true, message: 'Password has been reset successfully.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/change-password', authenticate, rateLimitChangePassword, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword, rememberMe } = req.body;
    if (!currentPassword || typeof currentPassword !== 'string') {
      res.status(400).json({ success: false, error: 'Current password is required' });
      return;
    }
    if (!newPassword || typeof newPassword !== 'string') {
      res.status(400).json({ success: false, error: 'New password is required' });
      return;
    }
    const tokens = await changePassword(req.user!.userId, currentPassword, newPassword, rememberMe ?? true);
    res.json({ success: true, message: 'Password changed successfully.', data: tokens });
  } catch (err) {
    next(err);
  }
});
