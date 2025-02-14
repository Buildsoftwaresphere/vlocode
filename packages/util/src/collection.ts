// File contains several functions for manipulating or accessing collectiong like objects such as: Set, Map and Array
import { Iterable } from './iterable';

/**
 * Polyfill for array.flat
 * @param array Array to flatten
 * @param depth Depth to flat to
 */
export function flatten<T>(array: T[], depth: number = 1) : T {
    depth = isNaN(depth) ? 1 : Number(depth);
    // @ts-ignore
    return depth ? array.reduce((acc: T[], cur: T[] | T) => {
        if (Array.isArray(cur)) {
            acc.push.apply(acc, flatten(cur, depth - 1));
        } else {
            acc.push(cur);
        }
        return acc;
    }, []) : array;
}

/**
 * Get unique values from an Array based on the specified fnction which returns the key or object making the item unique
 * @param arr Array
 * @param uniqueKeyFunc Filter that determines uniqueness of an item
 */
export function *unique<T, K, M = T>(itr: Iterable<T>, uniqueKeyFunc?: (item: T) => K, mapFunc?: (item: T) => M) : Generator<M> {
    const uniqueSet = new Set();
    for (const item of itr) {
        const k = uniqueKeyFunc ? uniqueKeyFunc(item) : item;
        if (!uniqueSet.has(k)) {
            if (mapFunc) {
                yield mapFunc(item);
            } else {
                yield item as unknown as M;
            }
            uniqueSet.add(k);
        }
    }
}

/**
 * Groups an array into key accessible groups of objects
 * @param iterable iterable items to group
 * @param predicate function to get the group by key
 */
export function groupBy<T>(iterable: Iterable<T>, keySelector: (item: T) => string | undefined) : { [objectKey: string]: T[] } {
    return asArray(iterable).reduce(
        (arr, item) => {
            const key = keySelector(item);
            if (key) {
                if (!arr[key]) {
                    arr[key] = [];
                }
                arr[key].push(item);
            }
            return arr;
        }, {} as { [objectKey: string]: T[] }
    );
}

/**
 * Iterable helper includes an index on the IterableIterator return value
 * @param iterable The iterable object
 * @yields {[number, T]}
 */
function* enumerateWithIndex<T>(iterable: Iterable<T>) : IterableIterator<[number, T]> {
    let i = 0;
    for (const x of iterable) {
        yield [i++, x];
    }
}

/**
 * Execute the map callback async in sequence on each of the items in the specified Iterable
 * @param array An Iterable to execute the callback on
 * @param callback The callback to execute for each item
 */
export function mapAsync<T,R>(array: Iterable<T>, callback: (item: T) => Promise<R>) : Promise<R[]> {
    let mapPromise = Promise.resolve(new Array<R>());
    for (const value of array) {
        mapPromise = mapPromise.then(async result => result.concat(await callback(value)));
    }
    return mapPromise;
}

/**
 * Execute callback async in sequence on each of the items in the specified array
 * @param array Array to execute the callback on
 * @param callback The callback to execute for each item
 */
export function forEachAsync<T>(array: T[], callback: (item: T, index?: number, array?: T[]) => Promise<any>) : Promise<T[]> {
    let foreachPromise = Promise.resolve();
    for (let i = 0; i < array.length; i++) {
        foreachPromise = foreachPromise.then(() => callback(array[i], i, array));
    }
    return foreachPromise.then(() => array);
}

/**
 * Execute callback async in parallel on each of the items in the specified array
 * @param iterable An Iterable to execute the callback on
 * @param callback The callback to execute for each item
 */
export function forEachAsyncParallel<T>(iterable: Iterable<T>, callback: (item: T, index?: number, array?: T[]) => PromiseLike<any>, parallelism = 2) : Promise<T[]> {
    return mapAsyncParallel(iterable, async item => {
        await callback(item);
        return item;
    }, parallelism);
}

/**
 * Execute the map callback async in parallel on each of the items in the specified Iterable
 * @param array An Iterable to execute the callback on
 * @param callback The callback to execute for each item
 */
export function mapAsyncParallel<T,R>(iterable: Iterable<T>, callback: (item: T) => PromiseLike<R>, parallelism = 2) : Promise<R[]> {
    const tasks : Promise<R[]>[] = new Array(parallelism).fill(Promise.resolve(new Array<R>()));
    for (const [index, value] of enumerateWithIndex(iterable)) {
        tasks[index % parallelism] = tasks[index % parallelism].then(async result => result.concat(await callback(value)));
    }
    return Promise.all(tasks).then(flatten);
}

/**
 * Execute the filter callback async in parallel on each of the items in the specified array
 * @param array An Iterable to execute the callback on
 * @param callback The callback to execute for each item
 */
export async function filterAsyncParallel<T>(array: Iterable<T>, callback: (item: T) => PromiseLike<boolean>, parallelism = 2) : Promise<T[]> {
    const result : T[] = [];
    await mapAsyncParallel(array, async item => !(await callback(item)) || result.push(item), parallelism);
    return result;
}

/**
 * Add a value to an array inside of a map; if the array is not created create it and then push the value
 * @param map Map of Array<T>'s
 * @param key Key in the map
 * @param value Value to add to the array
 */
export function arrayMapPush<T, K>(map: Map<K, Array<T>>, key: K, value: T) : number {
    // @ts-expect-error set followed by get for the same key will never return undefined
    return (map.get(key) || map.set(key, []).get(key)).push(value);
}

/**
 * Add a value to the start of an array inside of a map; if the array is not created create it and then push the value
 * @param map Map of Array<T>'s
 * @param key Key in the map
 * @param value Value to add to the array
 */
export function arrayMapUnshift<T, K>(map: Map<K, Array<T>>, key: K, value: T) : number {
    // @ts-expect-error set followed by get for the same key will never return undefined
    return (map.get(key) || map.set(key, []).get(key)).unshift(value);
}

/**
 * Add a value to an Set inside of a map; if the array is not created create it and then push the value
 * @param map Map of Set<T>'s
 * @param key Key in the map
 * @param value Value to add to the array
 */
export function setMapAdd<T, K>(map: Map<K, Set<T>>, key: K, value: T) : Set<T> {
    // @ts-expect-error set followed by get for the same key will never return undefined
    return (map.get(key) || map.set(key, new Set<T>()).get(key)).add(value);
}

/**
 * Get or create a value for the specified key
 * @param map Map to get or create the value in
 * @param key Key of the value in the map
 * @param valueInitializer Value initializer call when the value is not set
 */
export function mapGetOrCreate<V, K>(map: Map<K, V>, key: K, valueInitializer: () => V) : V {
    // @ts-expect-error set followed by get for the same key will never return undefined
    return map.get(key) || map.set(key, valueInitializer()).get(key);
}


/**
 * Converts specified array-like arguments to a single array; may return original parameter if only a single param is specified and that 
 * param is already an array. Otherwise the provided parameters are copied to a new array.
 * @param elements 
 */
export function asArray<T>(...elements: Array<T[] | T | Iterable<T>>) : T[] {
    if (elements.length == 1 && Array.isArray(elements[0])) {
        return elements[0];
    }
    const results : T[] = [];
    for (const element of elements) {
        if (Array.isArray(element)) {
            results.push(...element);
        } else if (typeof element !== 'string' && Iterable.isIterable(element)) {
            results.push(...element);
        } else {
            results.push(element);
        }
    }
    return results;
}

/**
 * Type guarded filter expression to remove undefined and null entries from an array
 */
export function filterUndefined<T>(iterable: Iterable<T | undefined>): Array<T> {
    const result = new Array<T>();
    for (const value of iterable) {
        if (value !== undefined && value !== null) {
            result.push(value);
        }
    }
    return result;
}

/**
 * Get the last element from an array similair to pop but without removing the element. 
 * @param array Atray to get the last element from. Array is not altered.
 */
export function last<T>(array: Array<T>): T | undefined {
    return array.length ? array[array.length - 1] : undefined;
}

/**
 * Intersect the elements of two arrays, returns a new array with only the elements present in both arrays.
 * @param source source array
 * @param target Target array
 */
export function intersect<T>(source: Array<T>, target: Array<T>): Array<T> {
    const intersected = new Array<T>();
    source.forEach(element => target.indexOf(element) != -1 && intersected.push(element));
    return intersected;
}

/**
 * Returns a new array with the elements from the source array that are not present in the target array
 * @param target Target array
 * @param source source array
 */
export function except<T>(source: Array<T>, target: Array<T>): Array<T> {
    const excepted = new Array<T>();
    source.forEach(element => target.indexOf(element) == -1 && excepted.push(element));
    return excepted;
}

/**
 * Remove the first element from the array that matches the specified predicate 
 * @param source Source array
 * @param predicate predicate to match
 * @returns Item or undefined when not found
 */
export function remove<T>(source: Array<T>, predicate: (item: T, index: number) => boolean): T | undefined {
    const index = source.findIndex(predicate);
    if (index != -1) {
        const [ removedItem ] = source.splice(index, 1);
        return removedItem;
    }
}

/**
 * Spread async generators into an array 
 * @param gen Async generator to spread
 * @returns Array of results from the generator
 */
export async function spreadAsync<T>(gen: AsyncGenerator<T>): Promise<T[]>{
    const items = Array<T>();
    for await (const item of gen) {
        items.push(item);
    }
    return items;
}