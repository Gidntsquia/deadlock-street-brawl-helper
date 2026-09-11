import { img } from '../data/load';
import type { Item } from '../types';

const ROMAN = ['', 'I', 'II', 'III', 'IV'];

// One shop-style item card: slot-tinted art, roman tier tab top-right, name plate below.
export function ItemTile({ item, order, isCore, onClick, ariaLabel, total, cost }: {
  item: Item; order?: number; isCore?: boolean; onClick?: () => void; ariaLabel?: string; total?: number; cost?: number;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`tile ${item.item_slot_type}`} onClick={onClick} aria-label={ariaLabel} data-cost={cost ?? item.cost} data-total={total} data-core={isCore === undefined ? undefined : String(isCore)}>
      <span className="art"><img src={img(item.shop_image_webp || item.image_webp)} alt="" loading="lazy" /></span>
      <span className={`tier t${item.item_tier}`}><span>{ROMAN[item.item_tier] ?? item.item_tier}</span></span>
      {order !== undefined && <span className="order">{order}</span>}
      {item.is_active_item && <span className="active-tag">ACTIVE</span>}
      {isCore && <span className="mark core" title="In the top player's core set">✓</span>}
      <span className="plate">{item.name}</span>
    </Tag>
  );
}
