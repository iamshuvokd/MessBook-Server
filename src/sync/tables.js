// Registry of every synced table: its SQL name, camelCase<->snake_case
// column map, and primary key. Drives the generic pull/push sync engine so
// adding a new synced table is a one-entry change here, not new routes.
//
// `groupScoped: true` means the table has a direct `group_id` column and
// can be filtered/pulled by it. Child tables that only reach the group via
// a parent id (expense_payers, expense_splits, meal_poll_votes) are synced
// alongside their parent in the same push/pull batch by the client, and
// are looked up here by parentTable/parentKey for the pull side.

const col = (camel, sqlType) => ({ camel, snake: camel.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), sqlType });

export const TABLES = {
  groups: {
    table: 'groups',
    primaryKey: ['id'],
    groupScoped: false, // the group row itself
    columns: [
      col('id'), col('name'), col('type'), col('currencySymbol'), col('monthStartDay'),
      col('mealEnabled'), col('mealLedgerSeparate'), col('defaultNonVoterPolicy'), col('archived'),
      col('createdAt'), col('updatedAt'),
    ],
  },
  members: {
    table: 'members',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [
      col('id'), col('groupId'), col('name'), col('phone'), col('photoPath'), col('joinDate'),
      col('leaveDate'), col('active'), col('role'), col('permissions'), col('updatedAt'),
    ],
  },
  categories: {
    table: 'categories',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [col('id'), col('groupId'), col('name'), col('defaultKey'), col('isMealCategory'), col('icon'), col('updatedAt')],
  },
  expenses: {
    table: 'expenses',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [
      col('id'), col('groupId'), col('amountPaisa'), col('date'), col('categoryId'), col('note'),
      col('receiptPath'), col('isRecurringInstance'), col('deleted'), col('updatedAt'),
    ],
  },
  expensePayers: {
    table: 'expense_payers',
    primaryKey: ['expenseId', 'memberId'],
    groupScoped: false,
    parent: { table: 'expenses', key: 'expenseId' },
    columns: [col('expenseId'), col('memberId'), col('amountPaidPaisa')],
  },
  expenseSplits: {
    table: 'expense_splits',
    primaryKey: ['expenseId', 'memberId'],
    groupScoped: false,
    parent: { table: 'expenses', key: 'expenseId' },
    columns: [col('expenseId'), col('memberId'), col('amountPaisa'), col('splitType')],
  },
  meals: {
    table: 'meals',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [col('id'), col('groupId'), col('memberId'), col('date'), col('count'), col('guestCount'), col('slotsJson'), col('updatedAt')],
  },
  deposits: {
    table: 'deposits',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [col('id'), col('groupId'), col('memberId'), col('amountPaisa'), col('date'), col('note'), col('purpose'), col('updatedAt')],
  },
  settlements: {
    table: 'settlements',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [
      col('id'), col('groupId'), col('fromMemberId'), col('toMemberId'), col('amountPaisa'), col('date'),
      col('method'), col('note'), col('purpose'), col('updatedAt'),
    ],
  },
  months: {
    table: 'months',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [
      col('id'), col('groupId'), col('yearMonth'), col('closedAt'), col('mealRatePaisa'), col('snapshotJson'),
      col('mealClosedAt'), col('mealSnapshotJson'),
    ],
    // months has no updatedAt column in the app schema; use closedAt-ish
    // fallback for LWW (see note in sync push handler).
    noUpdatedAt: true,
  },
  recurringRules: {
    table: 'recurring_rules',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [col('id'), col('groupId'), col('templateJson'), col('dayOfMonth'), col('active'), col('updatedAt')],
  },
  mealSlots: {
    table: 'meal_slots',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [col('id'), col('groupId'), col('name'), col('defaultKey'), col('weight'), col('sortOrder'), col('active'), col('updatedAt')],
  },
  memberMealRoutines: {
    table: 'member_meal_routines',
    primaryKey: ['id'],
    groupScoped: false,
    parent: { table: 'members', key: 'memberId' },
    columns: [col('id'), col('memberId'), col('slotId'), col('weekday'), col('enabled'), col('updatedAt')],
  },
  mealLeaves: {
    table: 'meal_leaves',
    primaryKey: ['id'],
    groupScoped: false,
    parent: { table: 'members', key: 'memberId' },
    columns: [col('id'), col('memberId'), col('fromDate'), col('toDate'), col('note'), col('updatedAt')],
  },
  bazarDuties: {
    table: 'bazar_duties',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [col('id'), col('groupId'), col('memberId'), col('date'), col('note'), col('done'), col('updatedAt')],
  },
  mealPolls: {
    table: 'meal_polls',
    primaryKey: ['id'],
    groupScoped: true,
    columns: [
      col('id'), col('groupId'), col('date'), col('type'), col('title'), col('optionsJson'),
      col('closeAt'), col('createdByMemberId'), col('nonVoterPolicy'), col('closed'), col('updatedAt'),
    ],
  },
  mealPollVotes: {
    table: 'meal_poll_votes',
    primaryKey: ['pollId', 'memberId'],
    groupScoped: false,
    parent: { table: 'meal_polls', key: 'pollId' },
    columns: [col('pollId'), col('memberId'), col('valueJson'), col('votedAt')],
  },
};

export function toSnakeRow(tableKey, camelRow) {
  const { columns } = TABLES[tableKey];
  const out = {};
  for (const c of columns) {
    if (camelRow[c.camel] !== undefined) out[c.snake] = camelRow[c.camel];
  }
  return out;
}

export function toCamelRow(tableKey, snakeRow) {
  const { columns } = TABLES[tableKey];
  const out = {};
  for (const c of columns) {
    if (snakeRow[c.snake] !== undefined) out[c.camel] = snakeRow[c.snake];
  }
  return out;
}
