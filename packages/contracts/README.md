# @agile-graph/contracts

The versioned schemas shared by
[`@agile-graph/engine`](https://www.npmjs.com/package/@agile-graph/engine):
project configuration and policy, context, execution plans and runs, and
decisions. Each contract is a TypeScript type with a matching runtime
validator.

```sh
npm install @agile-graph/contracts
```

```ts
import { DEFAULT_POLICY, assertProjectConfig } from "@agile-graph/contracts";
```

Most people never install this package directly; the engine depends on it.
See the [repository](https://github.com/MILTONADINA/agile-graph) for
documentation.

## License

MIT © 2026 Milton Adina.
