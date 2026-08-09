/**
 * Hand-written types for the Discourse internals we touch.
 *
 * These are not public API. They describe what devforum.roblox.com actually
 * exposed at the time of writing (Discourse 3.5.0.beta3-dev, PLUGIN_API_VERSION
 * 2.1.1) and exist so that a shape change shows up as a type error here rather
 * than as `undefined is not a function` inside Discourse's render loop.
 */

export type AmdFactory = (...deps: unknown[]) => unknown;

export interface AmdDefine {
  (name: string, deps: string[], factory: AmdFactory): void;
  amd?: unknown;
}

export interface AmdRequire {
  (name: string): unknown;
  entries?: Record<string, unknown>;
}

/** Ember initializer, as Discourse's resolver expects to find it. */
export interface EmberInitializer {
  name: string;
  after?: string | string[];
  before?: string | string[];
  initialize: (...args: unknown[]) => void;
}

export interface TransformerContext {
  [key: string]: unknown;
}

export interface ValueTransformerArgs<V> {
  value: V;
  context: TransformerContext;
}

export interface PluginApi {
  registerValueTransformer<V>(
    name: string,
    fn: (args: ValueTransformerArgs<V>) => V,
  ): void;
  registerBehaviorTransformer(
    name: string,
    fn: (args: { context: TransformerContext; next: () => void }) => void,
  ): void;
  decorateCookedElement(
    fn: (element: HTMLElement, helper?: unknown) => void,
    opts?: { id?: string; onlyStream?: boolean },
  ): void;
  onPageChange(fn: (url: string, title: string) => void): void;
  container?: unknown;
}

export interface PluginApiModule {
  PLUGIN_API_VERSION: string;
  withPluginApi(version: string, callback: (api: PluginApi) => void): void;
}

/** Topic shape as it appears in topic-list value transformer contexts. */
export interface DiscourseTopic {
  id: number;
  title?: string;
  slug?: string;
  posts_count?: number;
  reply_count?: number;
  like_count?: number;
  views?: number;
  category_id?: number;
  created_at?: string;
  bumped_at?: string;
  last_posted_at?: string;
  has_accepted_answer?: boolean;
  accepted_answer?: unknown;
  pinned?: boolean;
  closed?: boolean;
  archived?: boolean;
  unseen?: boolean;
  tags?: string[];
}

declare global {
  interface Window {
    define?: AmdDefine;
    require?: AmdRequire;
    /** Set by DFP so a second injection is a no-op. */
    __dfpInstalled?: boolean;
  }
}
