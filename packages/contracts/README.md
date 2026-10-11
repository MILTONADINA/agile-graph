# @graph-engineering/contracts

The versioned schemas shared by
[`@graph-engineering/engine`](https://www.npmjs.com/package/@graph-engineering/engine):
project configuration and policy, context, execution plans and runs, and
decisions. Each contract is a TypeScript type with a matching runtime
validator.

```sh
npm install @graph-engineering/contracts
```

```ts
import {
  DEFAULT_POLICY,
  assertProjectConfig,
} from "@graph-engineering/contracts";
```

Most people never install this package directly; the engine depends on it.
See the [repository](https://github.com/MILTONADINA/graph-engineering) for
documentation.

## License

MIT © 2026 Milton Adina.
