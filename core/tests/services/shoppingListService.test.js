'use strict';

const ShoppingListItem = require('../../models/ShoppingListItem');
const { shoppingList } = require('../../src/services/shoppingListService');

describe('the household shopping list', () => {
  beforeEach(async () => {
    await ShoppingListItem.deleteMany({});
    await ShoppingListItem.syncIndexes();
  });

  test('keeps one running list, ignores repeats and crosses items off', async () => {
    expect(await shoppingList({ action: 'add', items: ['avocat', 'lime', 'bifteck'] }))
      .toMatchObject({ added: ['avocat', 'lime', 'bifteck'], alreadyThere: [], items: ['avocat', 'lime', 'bifteck'] });
    expect(await shoppingList({ action: 'add', items: ['Avocat', 'lait', 'lait'] }))
      .toMatchObject({ added: ['lait'], alreadyThere: ['Avocat'], items: ['avocat', 'lime', 'bifteck', 'lait'] });

    expect(await shoppingList({ action: 'bought', items: ['Avocats', 'céleri'] }))
      .toMatchObject({ bought: ['avocat'], notFound: ['céleri'], items: ['lime', 'bifteck', 'lait'] });
    expect(await shoppingList({ action: 'add', items: ['avocat'] })).toMatchObject({ added: ['avocat'] });
    expect(await shoppingList({ action: 'list' })).toEqual({ items: ['lime', 'bifteck', 'lait', 'avocat'] });
  });

  test('matches accents and case, and refuses empty or unknown requests', async () => {
    await shoppingList({ action: 'add', items: ['Crème sure'] });
    expect(await shoppingList({ action: 'bought', items: ['creme sure'] })).toMatchObject({ bought: ['Crème sure'], items: [] });
    await expect(shoppingList({ action: 'add', items: ['  '] })).rejects.toMatchObject({ code: 'SHOPPING_LIST_INVALID' });
    await expect(shoppingList({ action: 'clear' })).rejects.toMatchObject({ code: 'SHOPPING_LIST_INVALID' });
  });
});
