import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from '../memory/in-memory-stores';
import {
  describeDeliveryLogStoreContract,
  describeReputationStoreContract,
  describeSuppressionStoreContract,
} from './store-contract';

// The in-memory stores are the reference implementations, so running the kit
// against them proves the kit itself. A host runs these same three functions
// against its own adapter.
//
// Deliberately NOT a refactor of in-memory-stores.spec.ts: that file is one of
// the 231 tests carried over unchanged from the original package, and rewriting
// it onto this kit would forfeit that guarantee. The overlap is accepted.
describeSuppressionStoreContract('InMemorySuppressionStore', () => new InMemorySuppressionStore());
describeDeliveryLogStoreContract('InMemoryDeliveryLogStore', () => new InMemoryDeliveryLogStore());
describeReputationStoreContract('InMemoryReputationStore', () => new InMemoryReputationStore());
