export type SlotType = 'weapon' | 'vitality' | 'spirit';

export interface ItemProperty { value: string | number; label?: string; postfix?: string; prefix?: string; css_class?: string }

export interface Item {
  id: number; class_name: string; name: string; cost: number;
  item_tier: number; item_slot_type: SlotType;
  shopable: boolean; disabled: boolean; is_active_item: boolean; activation?: string;
  component_items: string[];
  shop_image_webp?: string; image_webp?: string;
  description: { desc?: string; active?: string; passive?: string; [k: string]: string | undefined };
  tooltip_sections: TooltipSection[];
  properties: Record<string, ItemProperty>;
}
export interface TooltipSection {
  section_type?: string;
  section_attributes?: { properties?: string[]; elevated_properties?: string[]; important_properties?: string[]; loc_string?: string }[];
}

export interface Hero {
  id: number; name: string; class_name: string;
  description?: { role?: string; playstyle?: string; lore?: string };
  images: { small?: string; card?: string };
  starting_stats: Record<string, number>;
  standard_level_up_upgrades: Record<string, number>;
  level_info: Record<string, { required_gold?: number; bonus_currencies?: string[] }>;
  abilities: string[]; // class names of signature1..4
  gun_tag?: string; tags?: string[];
}

export interface Ability {
  id: number; class_name: string; name: string; hero: number; image_webp?: string;
  ability_type?: string; description: string;
  upgrades: { name: string; bonus: string }[][];
  properties: Record<string, { value: string | number; scale: string | string[] | null }>;
}

export interface ItemStat {
  item_id: number; wins: number; losses: number; matches: number; players: number;
  avg_buy_time_s: number; avg_sell_time_s: number; avg_buy_time_relative: number; avg_sell_time_relative: number;
}
export interface AbilityOrderStat { abilities: number[]; wins: number; losses: number; matches: number; players: number }
export interface PairStat { item_ids: number[]; wins: number; losses: number; matches: number }
export interface AnalyticsPopulation { item_stats: ItemStat[]; ability_order_stats: AbilityOrderStat[]; permutation_stats: PairStat[] }
/** Aggregate analytics for one hero: all ranks, plus (optionally) the high-rank population. */
export interface HeroAnalytics extends AnalyticsPopulation { hero_id: number; top?: AnalyticsPopulation & { min_average_badge: number; styles?: StylePopulation[] } }
/**
 * One build style of the high-rank population (see scripts/styles.mjs). `main` is the population with every
 * alternative style's anchor items excluded; an alternative style is the population of games where its seed
 * item was bought. Item and ability stats are conditional on that filter; pair stats are shared.
 */
export interface StylePopulation {
  key: string; seed: number | null; anchors: number[]; exclude: number[];
  matches: number; share: number; item_stats: ItemStat[]; ability_order_stats: AbilityOrderStat[];
}
/** Which aggregate population a build was generated from. */
export interface BuildPopulation {
  kind: 'top' | 'all'; minBadge: number | null; matches: number; abilitySequenceKind: 'top' | 'all';
  /** set when the hero has more than one established build style and this build is one of them */
  style?: { key: string; name: string; tagline: string; share: number; seed: Item | null; anchors: Item[]; exclude: Item[]; defining: Item[] };
}

export type Phase = 'early' | 'mid' | 'late';

export interface BuildItem {
  item: Item; phase: Phase; order: number; runningTotal: number;
  paidCost: number;            // cost after crediting a component already in the build
  upgradesFrom?: Item;         // the component this item upgrades (if in the build)
  score: number; reasons: string[];
  usageRate: number; winRate: number; avgBuyTimeS: number;
}
export interface AbilityStep { ability: Ability; kind: 'unlock' | 'tier1' | 'tier2' | 'tier3'; index: number }
export interface Build {
  key: string; name: string; tagline: string; heroId: number;
  items: BuildItem[]; totalCost: number;
  abilityOrder: AbilityStep[]; abilityOrderSupport: { matches: number; winRate: number } | null;
  population: BuildPopulation;
}
