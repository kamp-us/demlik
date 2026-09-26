import { helper } from './helper.js';
import type { Wire } from '@acme/wire-contract';
import { repo } from '../store/repo.js';
import { z } from 'zod';
export const score = helper + repo;
export type W = Wire | typeof z;
