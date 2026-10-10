import { adminClient, inferAdditionalFields } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/client';

export const authClient = createAuthClient({
  plugins: [adminClient(), inferAdditionalFields({ user: { locale: { type: 'string' } } })],
});
