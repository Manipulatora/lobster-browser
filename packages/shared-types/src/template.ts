import type { CreateProfileTemplateInput } from './profile.js';

/**
 * What a save sends for an existing profile template.
 *
 * A save REPLACES the fields a user owns rather than patching the ones it mentions, which is what
 * makes "No proxy" expressible at all: a patch whose absent fields mean "leave alone" can bind a
 * proxy but can never unbind one, and the same goes for clearing an OS version or the extension
 * list. The editor always holds the template's full state, so it always sends it. Identity and audit
 * fields (`id`, `createdAt`, `updatedAt`) belong to the store and are not writable.
 */
export type UpdateProfileTemplateInput = CreateProfileTemplateInput;
