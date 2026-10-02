const mongoose = require('mongoose');

// The household's single running shopping list. An item stays until someone
// marks it bought; adding the same item again while it is open is a no-op.
const ShoppingListItemSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 120 },
  key: { type: String, required: true },               // accent- and case-folded text
  status: { type: String, enum: ['open', 'bought'], default: 'open', index: true },
  addedBy: { type: String, default: 'nestor', maxlength: 60 },
  boughtAt: { type: Date, default: null }
}, { timestamps: true });

ShoppingListItemSchema.index(
  { key: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);

module.exports = mongoose.model('ShoppingListItem', ShoppingListItemSchema);
