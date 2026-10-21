import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

export class Conflict extends Error { constructor() { super('Conditional write failed'); this.name = 'Conflict'; } }
const copy = x => x === undefined ? undefined : structuredClone(x);
const keyOf = x => `${x.pk}\u0000${x.sk}`;
const valid = (item, c) => !c || (c.absent ? !item : c.exists ? !!item : c.lt !== undefined ? !item || item[c.attribute] < c.lt : item?.[c.attribute] === c.equals);

// Only local development and isolated tests use this in-process store.
export class MemoryStore {
  constructor() { this.items = new Map(); }
  async get(pk, sk) { return copy(this.items.get(keyOf({pk, sk}))); }
  async put(item, condition) { await this.transact([{put: item, condition}]); }
  async transact(ops) {
    for (const op of ops) if (!valid(this.items.get(keyOf(op.put || op.key)), op.condition)) throw new Conflict();
    for (const op of ops) {
      const key = keyOf(op.put || op.key);
      if (op.put) this.items.set(key, copy(op.put));
      else if (op.delete) this.items.delete(key);
      else {
        const value = {...this.items.get(key), ...op.key, ...op.set};
        for (const [name, amount] of Object.entries(op.add || {})) value[name] = (value[name] || 0) + amount;
        this.items.set(key, value);
      }
    }
  }
  async increment(pk, sk, expiresAt) {
    const key = keyOf({pk, sk});
    const value = this.items.get(key) || {pk, sk, count: 0, expiresAt};
    value.count++; this.items.set(key, value); return value.count;
  }
  async consume(key, limit, expiresAt) {
    await this.transact([{key: {pk: `RATE#${key}`, sk: 'N'}, set: {expiresAt}, add: {count: 1}, condition: {attribute: 'count', lt: limit}}]);
  }
  async query(pk, {from = '\u0000', to = '\uffff', reverse = false, limit = 100, index = false} = {}) {
    return [...this.items.values()].filter(x => (index ? x.gpk : x.pk) === pk && (index ? x.gsk : x.sk) >= from && (index ? x.gsk : x.sk) <= to)
      .sort((a, b) => String(index ? a.gsk : a.sk).localeCompare(String(index ? b.gsk : b.sk)) * (reverse ? -1 : 1)).slice(0, limit).map(copy);
  }
}

function conditionExpression(condition, names, values) {
  if (!condition) return undefined;
  names['#condition'] = condition.absent || condition.exists ? 'pk' : condition.attribute;
  if (condition.absent) return 'attribute_not_exists(#condition)';
  if (condition.exists) return 'attribute_exists(#condition)';
  values[':condition'] = condition.lt ?? condition.equals;
  return condition.lt !== undefined ? 'attribute_not_exists(#condition) OR #condition < :condition' : '#condition = :condition';
}
function writeOperation(op, table) {
  const names = {}, values = {};
  const expression = conditionExpression(op.condition, names, values);
  const common = {TableName: table, ...(expression && {ConditionExpression: expression}), ...(Object.keys(names).length && {ExpressionAttributeNames: names}), ...(Object.keys(values).length && {ExpressionAttributeValues: values})};
  if (op.put) return {Put: {...common, Item: op.put}};
  if (op.delete) return {Delete: {...common, Key: op.key}};
  const sets = [], adds = [];
  for (const [k, v] of Object.entries(op.set || {})) { const n = `#s${sets.length}`, p = `:s${sets.length}`; names[n] = k; values[p] = v; sets.push(`${n} = ${p}`); }
  for (const [k, v] of Object.entries(op.add || {})) { const n = `#a${adds.length}`, p = `:a${adds.length}`; names[n] = k; values[p] = v; adds.push(`${n} ${p}`); }
  return {Update: {...common, Key: op.key, ExpressionAttributeNames: names, ExpressionAttributeValues: values, UpdateExpression: [sets.length && `SET ${sets.join(', ')}`, adds.length && `ADD ${adds.join(', ')}`].filter(Boolean).join(' ')}};
}
function translate(error) {
  if (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionCanceledException' && error.CancellationReasons?.some(x => x.Code === 'ConditionalCheckFailed')) throw new Conflict();
  throw error;
}
export class DynamoDBStore {
  constructor(table, {client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {marshallOptions: {removeUndefinedValues: true}})} = {}) { this.table = table; this.client = client; }
  async get(pk, sk) { return (await this.client.send(new GetCommand({TableName: this.table, Key: {pk, sk}, ConsistentRead: true}))).Item; }
  async put(item, condition) { try { await this.client.send(new PutCommand(writeOperation({put: item, condition}, this.table).Put)); } catch (error) { translate(error); } }
  async transact(ops) { if (!ops.length) return; try { await this.client.send(new TransactWriteCommand({TransactItems: ops.map(op => writeOperation(op, this.table))})); } catch (error) { translate(error); } }
  async increment(pk, sk, expiresAt) {
    return (await this.client.send(new UpdateCommand({TableName: this.table, Key: {pk, sk}, UpdateExpression: 'SET expiresAt = :ttl ADD #count :one', ExpressionAttributeNames: {'#count': 'count'}, ExpressionAttributeValues: {':ttl': expiresAt, ':one': 1}, ReturnValues: 'UPDATED_NEW'}))).Attributes.count;
  }
  async consume(key, limit, expiresAt) {
    try { await this.client.send(new UpdateCommand(writeOperation({key: {pk: `RATE#${key}`, sk: 'N'}, set: {expiresAt}, add: {count: 1}, condition: {attribute: 'count', lt: limit}}, this.table).Update)); } catch (error) { translate(error); }
  }
  async query(pk, {from = '\u0000', to = '\uffff', reverse = false, limit = 100, index = false} = {}) {
    const items = []; let start;
    do {
      // DynamoDB's 1 MiB page ceiling can be reached before Limit, especially
      // for 100 encrypted chat messages. Preserve order across continuation pages.
      const result = await this.client.send(new QueryCommand({TableName: this.table, ...(index ? {IndexName: 'due'} : {ConsistentRead: true}), KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to', ExpressionAttributeNames: {'#pk': index ? 'gpk' : 'pk', '#sk': index ? 'gsk' : 'sk'}, ExpressionAttributeValues: {':pk': pk, ':from': from, ':to': to}, Limit: limit - items.length, ScanIndexForward: !reverse, ...(start && {ExclusiveStartKey: start})}));
      items.push(...result.Items || []); start = result.LastEvaluatedKey;
    } while (start && items.length < limit);
    return items;
  }
}
