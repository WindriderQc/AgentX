/**
 * Dashboard Service
 *
 * Validation and data execution for custom dashboards.
 */

const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const Alert = require('../../models/Alert');

const ALLOWED_WIDGET_TYPES = new Set(['metric', 'chart', 'table', 'markdown']);
const ALLOWED_CHART_TYPES = new Set(['line', 'bar', 'pie', 'doughnut', 'area']);
const ALLOWED_COLLECTIONS = new Set(['conversations', 'prompts', 'alerts']);
const ALLOWED_AGGREGATIONS = new Set(['count', 'sum', 'avg', 'min', 'max']);

const collectionMap = {
  conversations: Conversation,
  prompts: PromptConfig,
  alerts: Alert
};

function validateWidgetDefinition(widget) {
  const errors = [];

  if (!widget || typeof widget !== 'object') {
    return { isValid: false, errors: ['Widget must be an object.'] };
  }

  if (!widget.id || typeof widget.id !== 'string') {
    errors.push('Widget id is required.');
  }

  if (!widget.type || !ALLOWED_WIDGET_TYPES.has(widget.type)) {
    errors.push('Widget type is invalid.');
  }

  if (widget.chartType && !ALLOWED_CHART_TYPES.has(widget.chartType)) {
    errors.push('Chart type is invalid.');
  }

  if (widget.w !== undefined && (typeof widget.w !== 'number' || widget.w <= 0)) {
    errors.push('Widget width must be a positive number.');
  }

  if (widget.h !== undefined && (typeof widget.h !== 'number' || widget.h <= 0)) {
    errors.push('Widget height must be a positive number.');
  }

  if (!widget.dataSource || typeof widget.dataSource !== 'object') {
    errors.push('Widget dataSource is required.');
  } else {
    const { collection, aggregation, field, groupBy, pipeline, filter } = widget.dataSource;

    if (!collection || !ALLOWED_COLLECTIONS.has(collection)) {
      errors.push('Widget dataSource collection is invalid.');
    }

    if (filter !== undefined && (typeof filter !== 'object' || Array.isArray(filter))) {
      errors.push('Widget dataSource filter must be an object.');
    }

    if (widget.type === 'metric') {
      if (!aggregation || !ALLOWED_AGGREGATIONS.has(aggregation)) {
        errors.push('Metric aggregation is invalid.');
      }

      if (['sum', 'avg', 'min', 'max'].includes(aggregation) && !field) {
        errors.push('Metric aggregation requires a field.');
      }
    }

    if (widget.type === 'chart') {
      if (!groupBy || typeof groupBy !== 'string') {
        errors.push('Chart widgets require a groupBy field.');
      }
    }

    if (widget.type === 'table' && pipeline !== undefined) {
      if (!Array.isArray(pipeline)) {
        errors.push('Table pipeline must be an array.');
      }
    }
  }

  return { isValid: errors.length === 0, errors };
}

function validateDashboardLayout(layout) {
  if (layout === undefined) {
    return { isValid: true, errors: [] };
  }

  if (!Array.isArray(layout)) {
    return { isValid: false, errors: ['Layout must be an array.'] };
  }

  const errors = [];
  layout.forEach((widget, index) => {
    const result = validateWidgetDefinition(widget);
    if (!result.isValid) {
      errors.push(`Widget ${index + 1}: ${result.errors.join(' ')}`);
    }
  });

  return { isValid: errors.length === 0, errors };
}

async function executeWidgetQuery(widget, workspaceId) {
  const validation = validateWidgetDefinition(widget);
  if (!validation.isValid) {
    return { error: validation.errors.join(' ') };
  }

  const { dataSource } = widget;
  const Model = collectionMap[dataSource.collection];
  if (!Model) return { error: 'Invalid collection' };

  const matchStage = {
    workspaceId,
    ...dataSource.filter
  };

  if (widget.type === 'metric') {
    if (dataSource.aggregation === 'count') {
      const count = await Model.countDocuments(matchStage);
      return { value: count };
    }

    if (['sum', 'avg', 'min', 'max'].includes(dataSource.aggregation)) {
      const field = dataSource.field;
      if (!field) {
        return { value: 0, error: 'Field required for aggregation' };
      }

      const operator = {
        sum: '$sum',
        avg: '$avg',
        min: '$min',
        max: '$max'
      }[dataSource.aggregation];

      const pipeline = [
        { $match: matchStage },
        {
          $group: {
            _id: null,
            result: { [operator]: `$${field}` }
          }
        }
      ];

      const results = await Model.aggregate(pipeline);
      const value = results.length > 0 ? results[0].result : 0;

      return {
        value: dataSource.aggregation === 'avg'
          ? Math.round(value * 100) / 100
          : value
      };
    }

    return { value: 0, error: 'Invalid aggregation type' };
  }

  if (widget.type === 'chart') {
    const pipeline = [
      { $match: matchStage }
    ];

    if (dataSource.groupBy) {
      if (dataSource.groupBy === 'createdAt') {
        pipeline.push({
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        });
        pipeline.push({ $sort: { _id: 1 } });
      } else {
        pipeline.push({
          $group: {
            _id: `$${dataSource.groupBy}`,
            count: { $sum: 1 }
          }
        });
      }
    }

    const results = await Model.aggregate(pipeline);

    return {
      labels: results.map(r => r._id),
      datasets: [{
        label: widget.title || 'Count',
        data: results.map(r => r.count)
      }]
    };
  }

  if (widget.type === 'table') {
    let results;
    if (dataSource.pipeline && Array.isArray(dataSource.pipeline) && dataSource.pipeline.length > 0) {
      const enforcedMatch = { $match: { workspaceId } };
      results = await Model.aggregate([enforcedMatch, ...dataSource.pipeline]);
    } else {
      const fields = dataSource.field ? { [dataSource.field]: 1 } : {};
      results = await Model.find(matchStage, fields).limit(100).lean();
    }

    if (!results || results.length === 0) {
      return { columns: [], rows: [], total: 0 };
    }

    const columns = Object.keys(results[0]).filter(k => k !== '__v' && k !== 'workspaceId');

    const rows = results.map(doc => (
      columns.map(col => {
        const val = doc[col];
        if (val && typeof val === 'object' && val instanceof Date) {
          return val.toISOString();
        }
        if (val && typeof val === 'object') return JSON.stringify(val);
        return val;
      })
    ));

    return {
      columns,
      rows,
      total: results.length
    };
  }

  return null;
}

module.exports = {
  executeWidgetQuery,
  validateDashboardLayout,
  validateWidgetDefinition
};
