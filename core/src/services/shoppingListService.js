'use strict';

const ShoppingListItem = require('../../models/ShoppingListItem');

const MAX_ITEMS_PER_CALL = 30;
const MAX_TEXT = 120;

class ShoppingListError extends Error {
  constructor(message, code = 'SHOPPING_LIST_INVALID', status = 400) {
    super(message);
    this.name = 'ShoppingListError';
    this.code = code;
    this.status = status;
  }
}

function cleanText(value) {
  return String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function itemKey(text) {
  return cleanText(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function cleanItems(value) {
  const items = (Array.isArray(value) ? value : [value]).map(cleanText).filter(Boolean);
  if (!items.length) throw new ShoppingListError('items must name at least one article');
  if (items.length > MAX_ITEMS_PER_CALL) throw new ShoppingListError(`at most ${MAX_ITEMS_PER_CALL} items per call`);
  return [...new Map(items.map((text) => [itemKey(text), text])).values()];
}

async function openItems() {
  const rows = await ShoppingListItem.find({ status: 'open' }).sort({ createdAt: 1 }).lean();
  return rows.map((row) => row.text);
}

async function addItems(value, { addedBy = 'nestor' } = {}) {
  const added = [];
  const alreadyThere = [];
  for (const text of cleanItems(value)) {
    // Upsert on the open item: no duplicate even before the unique index exists.
    const existing = await ShoppingListItem.findOneAndUpdate(
      { key: itemKey(text), status: 'open' },
      { $setOnInsert: { text, addedBy: cleanText(addedBy).slice(0, 60) || 'nestor' } },
      { upsert: true, new: false }
    ).lean().catch((error) => {
      if (error?.code === 11000) return true;
      throw error;
    });
    (existing ? alreadyThere : added).push(text);
  }
  return { added, alreadyThere, items: await openItems() };
}

// Match by folded text so "avocat", "Avocats" or "avocat " all find the item.
async function markBought(value) {
  const bought = [];
  const notFound = [];
  for (const text of cleanItems(value)) {
    const key = itemKey(text);
    const row = await ShoppingListItem.findOneAndUpdate(
      { status: 'open', key: { $in: [key, key.replace(/s$/, ''), `${key}s`] } },
      { $set: { status: 'bought', boughtAt: new Date() } },
      { new: true }
    ).lean();
    if (row) bought.push(row.text);
    else notFound.push(text);
  }
  return { bought, notFound, items: await openItems() };
}

async function shoppingList(input = {}) {
  const action = String(input.action || 'list');
  if (action === 'list') return { items: await openItems() };
  if (action === 'add') return addItems(input.items, { addedBy: input.addedBy });
  if (action === 'bought') return markBought(input.items);
  throw new ShoppingListError('action must be add, list or bought');
}

module.exports = { ShoppingListError, addItems, itemKey, markBought, openItems, shoppingList };
