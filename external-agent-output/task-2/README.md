# Task Package 2: Feature Inventory Scanning Algorithm

This package contains the implementation for the feature scanning and alignment algorithm requested in Task Package 2.

## Contents

- `src/services/featureInventoryService.js`: The core Node.js service class implementing the scanning and matching logic.
- `tests/featureInventoryService.test.js`: Jest test suite with filesystem mocks.
- `ALGORITHM_LOGIC.md`: Detailed documentation of regex patterns and scoring algorithms.

## Usage

### 1. Integration
To use this service in the main application:

```javascript
const FeatureInventoryService = require('./path/to/featureInventoryService');
const path = require('path');

const rootPath = path.resolve(__dirname, '../../..'); // Point to AgentX root
const scanner = new FeatureInventoryService(rootPath);

scanner.generateAlignmentReport().then(report => {
    console.log(JSON.stringify(report, null, 2));
});
```

### 2. Running Tests
You can run the tests using Jest. If Jest is installed globally or in the project:

```bash
# From the root workspace
npx jest external-agent-output/task-2/tests/featureInventoryService.test.js
```

## Logic Summary
The scanner looks for:
- **Frontend**: `.html` files in `public/` and Controller classes in `public/js`.
- **Backend**: `*Routes.js` files in `routes/` and `*Service.js` files in `src/services/`.
- **Docs**: `.md` files in `docs/` and the root directory.

It aligns them by normalizing filenames (e.g., `authRoutes.js` -> `auth`, `AUTH.md` -> `auth`) and calculates a coverage score.
