import type { InferSelectModel } from 'drizzle-orm';
import z from 'zod';
import { isIPv4, isIPv6 } from 'is-ip';

import type { client } from './schema';

import {
  AddressSchema,
  AllowedIpsSchema,
  AwgRangeSchema,
  DnsSchema,
  EnabledSchema,
  FirewallIpsSchema,
  HookSchema,
  ISchema,
  JcSchema,
  JmaxSchema,
  JminSchema,
  MtuSchema,
  PersistentKeepaliveSchema,
  controlStringRefine,
  safeStringRefine,
  schemaForType,
  t,
} from '#server/utils/types';

export type ClientType = InferSelectModel<typeof client>;

export type ClientNextIpType = Pick<ClientType, 'ipv4Address' | 'ipv6Address'>;

export type CreateClientType = Omit<
  ClientType,
  'createdAt' | 'updatedAt' | 'id'
>;

type QuotaFields =
  | 'quotaLimit'
  | 'quotaPeriod'
  | 'quotaUsed'
  | 'quotaAnchor'
  | 'quotaPeriodStart'
  | 'quotaExceeded';

/** Quota fields are admin-only and updated through {@link ClientQuotaUpdateSchema} */
export type UpdateClientType = Omit<
  CreateClientType,
  | 'privateKey'
  | 'publicKey'
  | 'preSharedKey'
  | 'userId'
  | 'interfaceId'
  | QuotaFields
>;

export type QuotaPeriod = ClientType['quotaPeriod'];

const name = z
  .string({ message: t('zod.client.name') })
  .min(1, t('zod.client.name'))
  .pipe(safeStringRefine)
  .pipe(controlStringRefine);

// TODO?: validate iso string
const expiresAt = z
  .string({ message: t('zod.client.expiresAt') })
  .min(1, t('zod.client.expiresAt'))
  .pipe(safeStringRefine)
  .nullable();

const address4 = z
  .string({ message: t('zod.client.address4') })
  .min(1, { message: t('zod.client.address4') })
  .pipe(safeStringRefine)
  .pipe(controlStringRefine)
  .refine((v) => isIPv4(v));

const address6 = z
  .string({ message: t('zod.client.address6') })
  .min(1, { message: t('zod.client.address6') })
  .pipe(safeStringRefine)
  .pipe(controlStringRefine)
  .refine((v) => isIPv6(v));

const serverAllowedIps = z.array(AddressSchema, {
  message: t('zod.client.serverAllowedIps'),
});

const quotaLimit = z
  .number({ message: t('zod.client.quotaLimit') })
  .int(t('zod.client.quotaLimit'))
  .min(1, t('zod.client.quotaLimit'))
  .max(Number.MAX_SAFE_INTEGER, t('zod.client.quotaLimit'))
  .nullable();

const quotaPeriod = z.enum(['none', 'day', 'week', 'month'], {
  message: t('zod.client.quotaPeriod'),
});

export const ClientCreateSchema = z.object({
  name: name,
  expiresAt: expiresAt,
  // optional so existing API clients keep working
  quotaLimit: quotaLimit.default(null),
  quotaPeriod: quotaPeriod.default('none'),
});

export type ClientCreateType = z.infer<typeof ClientCreateSchema>;

const filter = z.string().pipe(safeStringRefine);

const sort = z.enum(['asc', 'desc']);

export const ClientQuerySchema = z.object({
  filter: filter.optional(),
  sort: sort.optional(),
});

export type ClientQueryType = z.infer<typeof ClientQuerySchema>;

export const ClientUpdateSchema = schemaForType<UpdateClientType>()(
  z.object({
    name: name,
    enabled: EnabledSchema,
    expiresAt: expiresAt,
    ipv4Address: address4,
    ipv6Address: address6,
    preUp: HookSchema,
    postUp: HookSchema,
    preDown: HookSchema,
    postDown: HookSchema,
    allowedIps: AllowedIpsSchema.nullable(),
    serverAllowedIps: serverAllowedIps,
    firewallIps: FirewallIpsSchema.nullable(),
    mtu: MtuSchema,
    jC: JcSchema,
    jMin: JminSchema,
    jMax: JmaxSchema,
    i1: ISchema,
    i2: ISchema,
    i3: ISchema,
    i4: ISchema,
    i5: ISchema,
    contentPaddingAddition: AwgRangeSchema,
    rekeyAfterTime: AwgRangeSchema,
    rekeyTimeout: AwgRangeSchema,
    rejectAfterTime: AwgRangeSchema,
    keepaliveTimeout: AwgRangeSchema,
    maxHandshakeAttempts: AwgRangeSchema,
    disableCookies: z.boolean().nullable(),
    persistentKeepalive: PersistentKeepaliveSchema,
    serverEndpoint: AddressSchema.nullable(),
    dns: DnsSchema.nullable(),
  })
);

export const ClientQuotaUpdateSchema = z.object({
  quotaLimit: quotaLimit,
  quotaPeriod: quotaPeriod,
});

export type ClientQuotaUpdateType = z.infer<typeof ClientQuotaUpdateSchema>;

const clientId = z.coerce.number({ message: t('zod.client.id') });

export const ClientGetSchema = z.object({
  clientId: clientId,
});

export type ClientCreateFromExistingType = Pick<
  ClientType,
  | 'name'
  | 'ipv4Address'
  | 'ipv6Address'
  | 'privateKey'
  | 'preSharedKey'
  | 'publicKey'
  | 'enabled'
>;
