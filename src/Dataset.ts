// A Dataset manages the production and manipulation of *tiles*.

import { Tile, Rectangle, QuadTile } from './tile';
import {
  extent, range, min, max, bisectLeft,
} from 'd3-array';
import Zoom from './interaction';
import * as Comlink from 'comlink';

//@ts-ignore
import TileWorker from './tileworker.worker.js?worker&inline';
import { APICall } from './types';
import Scatterplot from './deepscatter';
type Key = string;

export abstract class Dataset<T extends Tile> {
  abstract root_tile : T;
//  public mutations : 
  public max_ix : number = -1;
  protected plot : Scatterplot;
  protected _tileworkers: TileWorker[] = [];
  abstract ready : Promise<void>;
  constructor(plot : Scatterplot) {
    this.plot = plot;
  }
  static from_quadfeather(url : string, prefs: APICall, plot: Scatterplot) : QuadtileSet {
    if (url.match(/(\/[0-9]+){3}/)) {
      throw new Error('Quadfeathers must be loaded from a base URL.');
    }
    return new QuadtileSet(url, prefs, plot);
  }

  get extent() : Rectangle {
    return {
      x: [-1e16, 1e16],
      y: [-1e16, 1e16],
    }
  }

  download_most_needed_tiles(bbox : Rectangle, max_ix: number, queue_length : number) {
    throw new Error('Tile download not implemented');
  }

  map(callback : (tile: T) => any, after = false) {
    // perform a function on each tile and return the values in order.
    const q : any[] = [];
    this.visit((d : any) => { q.push(callback(d)); }, after = after);
    return q;
  }

  visit(callback :  (tile: T) => void, after = false, filter :  (t : T) => boolean = (x) => true) {
    // Visit all children with a callback function.
    // The general architecture here is taken from the
    // d3 quadtree functions. That's why, for example, it doesn't
    // recurse.

    // filter is a condition to stop descending a node.
    const stack : T[] = [this.root_tile];
    const after_stack = [];
    let current;
    while (current = stack.shift()) {
      if (!after) {
        callback(current);
      } else {
        after_stack.push(current);
      }
      if (!filter(current)) {
        continue;
      }
      // Only create children for downloaded tiles.
      if (current.download_state == 'Complete') {        
        stack.push(...current.children);
      }
    }
    if (after) {
      while (current = after_stack.pop()) {
        callback(current);
      }
    }
  }

  findPoint(ix : number) {
    return this
      .map((t) => t) // iterates over children.
      .filter((t) => t.ready && t.table && t.min_ix <= ix && t.max_ix >= ix)
      .map((t) => {
        const mid = bisectLeft([...t.table.getChild('ix').data[0].values], ix);
        if (t.table.get(mid) && t.table.get(mid).ix === ix) {
          return t.table.get(mid);
        }
        return null;
      })
      .filter((d) => d);
  }


  get tileWorker() {
    const NUM_WORKERS = 4;
    if (this._tileworkers.length > 0) {
      // Apportion the workers randomly whener one is asked for.
      // Might be a way to have a promise queue that's a little more
      // orderly.
      this._tileworkers.unshift(this._tileworkers.pop());
      return this._tileworkers[0];
    }
    for (const i of range(NUM_WORKERS)) {
      this._tileworkers.push(
        //          Comlink.wrap(new Worker(this.url + '/../worker.js')),
        Comlink.wrap(new TileWorker()),
      );
    }
    return this._tileworkers[0];
  }

}



export class QuadtileSet extends Dataset<QuadTile> {
  protected _tileWorkers : TileWorker[] = [];
  protected _download_queue : Set<Key> = new Set();
  root_tile : QuadTile;

  constructor(base_url : string, prefs: APICall, plot: Scatterplot) {
    super(plot)
    this.root_tile = new QuadTile(base_url, "0/0/0", null, this);
  }

  get ready() {
    return this.root_tile.download();
  }
  get extent() {
    return this.root_tile.extent;
  }

  download_most_needed_tiles(bbox : Rectangle, max_ix: number, queue_length = 4) {
    /*
      Browsing can spawn a  *lot* of download requests that persist on
      unneeded parts of the database. So the tile handles its own queue for dispatching
      downloads in case tiles have slipped from view while parents were requested.
    */

    const queue = this._download_queue;

    if (queue.size >= queue_length) {
      return;
    }

    const scores : [number, QuadTile, Rectangle][] = [];
    function callback (tile : QuadTile) {
      if (tile.download_state === 'Unattempted') {
        const distance = check_overlap(tile, bbox);
        scores.push([distance, tile, bbox]);
      }
    };

    this.visit(
      callback,
    );

    scores.sort((a, b) => a[0] - b[0]);
    while (scores.length && queue.size < queue_length) {
      const upnext = scores.pop();
      if (upnext === undefined) {throw new Error("Ran out of tiles unexpectedly");}
      const [distance, tile, _] = upnext;
      if ((tile.min_ix && tile.min_ix > max_ix) || distance <= 0) {
        continue;
      }
      queue.add(tile.key);
      tile.download()
        .catch((err) => {
          console.warn('Error on', tile.key);
          queue.delete(tile.key);
          throw (err);
        })
        .then(() => queue.delete(tile.key));
    }
  }

}


function area(rect : Rectangle) {
  return (rect.x[1] - rect.x[0]) * (rect.y[1] - rect.y[0]);
}

function check_overlap(tile : Tile, bbox : Rectangle) : number {
  /* the area of Intersect(tile, bbox) expressed
     as a percentage of the area of bbox */
  const c : Rectangle = tile.extent;

  if (c.x[0] > bbox.x[1]
      || c.x[1] < bbox.x[0]
      || c.y[0] > bbox.y[1]
      || c.y[1] < bbox.y[0]
  ) {
    return 0;
  }

  const intersection : Rectangle = {
    x: [
      max([bbox.x[0], c.x[0]]),
      min([bbox.x[1], c.x[1]]),
    ],
    y: [
      max([bbox.y[0], c.y[0]]),
      min([bbox.y[1], c.y[1]]),
    ],
  };
  const { x, y } = intersection;
  let disqualify = 0;
  if (x[0] > x[1]) { disqualify -= 1; }
  if (y[0] > y[1]) { disqualify -= 2; }
  if (disqualify < 0) {
    return disqualify;
  }
  return area(intersection) / area(bbox);
}