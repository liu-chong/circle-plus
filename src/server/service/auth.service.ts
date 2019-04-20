import config from '../config';
import jwt from 'jsonwebtoken';
import {UserRecord} from '../models/user.model';
import {NextFunction, Request, RequestHandler, Response} from "express";
import {asyncMiddleware, respondWith} from "../utils/index";
import {$status} from "../constants/symbols";
import {ACCESS_TOKEN_COOKIE_KEY, ACCESS_TOKEN_KEY, Roles, UserRanks} from "../../shared/constants";
import {AccessTokenData} from "../../shared/interf";
import {isString} from "util";
import {INVALID_NUMERIC_ID, userObfuscator} from "./obfuscator.service";

const $requestUser = Symbol('request user');

const getToken = (() => {
  const Bearer = 'Bearer ';
  return (req: Request) => {
    if (req.headers && req.headers.authorization && (req.headers.authorization as string).startsWith(Bearer)) {
      return (req.headers.authorization as string).substring(Bearer.length);
    } else {
      return (req.query && req.query[ACCESS_TOKEN_KEY]) || req.cookies[ACCESS_TOKEN_COOKIE_KEY];
    }
  };
})();

export interface JwtSignable {
  getJwtPayload(): any;
}

export class JwtHelper<TPayload extends JwtSignable, TResult = TPayload> {
  constructor(private secret: string, private defaultExpire: string | number) {

  }

  async sign(payload: TPayload, expire?: string | number): Promise<string> {
    return new Promise((resolve, reject) => {
      return jwt.sign(payload.getJwtPayload(), this.secret, {
        expiresIn: expire || this.defaultExpire
      }, (err, token) => {
        if (err) {
          reject(err);
        } else {
          resolve(token);
        }
      });
    });
  }

  async verify(token: string): Promise<TResult> {
    return new Promise((resolve, reject) => {
      jwt.verify(token, this.secret, (err, payload) => {
        if (err) {
          reject(err);
        } else {
          resolve(payload as any as TResult);
        }
      });
    });
  }
}

export class AuthService extends JwtHelper<UserRecord, AccessTokenData> {

  async setTokenCookie(user: UserRecord, res: Response) {
    res.cookie(ACCESS_TOKEN_COOKIE_KEY, await this.sign(user));
  }

  async decodeRequestUser(req: Request): Promise<UserRecord | undefined> {
    const token = getToken(req);
    if (!token) {
      return;
    }
    const payload = await this.verify(token);
    const user = Object.create(UserRecord.prototype);
    user.unObfuscateAssign(payload);
    return user;
  }

  async decodeUserIdFromToken(token: any) {
    if (token && isString(token)) {
      try {
        const payload = await this.verify(token);
        return userObfuscator.unObfuscate(payload.id);
      } catch (e) {
        // swallow
      }
    }
    return INVALID_NUMERIC_ID;
  }

  requireRole(requiredRole: string): RequestHandler {
    const self = this;
    const requiredRank = UserRanks[requiredRole];
    return asyncMiddleware(async function(req: Request, res: Response, next: NextFunction) {
      const user = await self.decodeRequestUser(req);
      if (user) {
        req[$requestUser] = user;
        if (req[$requestUser].role >= requiredRank) {
          return next();
        }
      }
      respondWith(res, 403);
    });
  }
}

export const authService = new AuthService(config.secrets.auth!, '5h');

export const requireAdmin = authService.requireRole(Roles.Admin);

export const requireLogin = asyncMiddleware(async function(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await authService.decodeRequestUser(req);
    if (!user) {
      return respondWith(res, 401);
    }
    req[$requestUser] = user;
    next();
  } catch (e) {
    (e as any)[$status] = 401;
    next(e);
  }
});

export function getRequestUser(req: Request): UserRecord {
  return req[$requestUser];
}

export class SignUpPayload implements JwtSignable {
  constructor(readonly email: string) {
  }

  getJwtPayload(): object {
    return this;
  }
}

export const signUpService = new JwtHelper<SignUpPayload>(config.secrets.signUp!, '2d');

