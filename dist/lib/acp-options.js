/**
 * The ACP values the adapter reads and the pure rules it applies to them: which config option serves
 * a setting, what a select option lists, how a stop reason maps. No transport, no state.
 */
export const PROTOCOL_VERSION = 1;
export const asRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
/** The status a completed prompt reports for each ACP stop reason. */
export const STOP_STATUS = { end_turn: 'finished', cancelled: 'cancelled', refusal: 'refused' };
export const selected = (optionId) => optionId === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId } };
/** The option the agent advertised for one category, matched by category and then by id. */
export function configOption(configOptions, category) {
    return configOptions.find(option => option.category === category) ?? configOptions.find(option => option.id === category);
}
/** Flat and grouped select options become the same list. */
export function selectValues(option) {
    const flat = (option.options ?? []).flatMap(entry => (entry.options === undefined ? [entry] : entry.options));
    return flat.flatMap(entry => typeof entry.value === 'string' && entry.value.length > 0
        ? [{ value: entry.value, name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.value }]
        : []);
}
/** `low`/`Low`/`HIGH` all resolve to the value the agent actually listed. */
export function thoughtLevelValue(option, wanted) {
    const requested = wanted.toLowerCase();
    return selectValues(option).find(entry => entry.value.toLowerCase() === requested || entry.name.toLowerCase() === requested)?.value;
}
