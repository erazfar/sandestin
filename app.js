var channelsPerPixel = 4;

// "await sleep(1000)"
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/*****************************************************************************/
/* Model geometry                                                            */
/*****************************************************************************/

let nodes = [];
let edges = [];
let pixels = [];
let outputSlotToPixel = [];

class Pixel {
  constructor(point, outputSlot) {
    this.id = pixels.length;
    pixels[this.id] = this;

    this.point = point;
    this.outputSlot = outputSlot;
    if (outputSlotToPixel[outputSlot] !== undefined)
      throw new Error(`channel collision at channel ${firstChannel}`)
    outputSlotToPixel[outputSlot] = this;
  }
}

class Node {
  constructor(point) {
    this.id = nodes.length;
    nodes[this.id] = this;

    this.point = point;
    this.edges = [];
  }
}

class Edge {
  constructor(startNode, endNode, numPixels, firstOutputSlot) {
    this.id = edges.length;
    edges[this.id] = this;

    this.startNode = startNode;
    startNode.edges.push(this);
    this.endNode = endNode;
    endNode.edges.push(this);

    this.pixels = [];
    for(let i = 0; i < numPixels; i ++) {
      // Evenly space the pixels along the edge, with the same space between startNode
      // and the first pixel, and endNode and the last pixel, as between adjacent pixels
      let frac = (i + 1) / (numPixels + 1);
      let pixel = new Pixel(
        [0, 1, 2].map(j =>
          startNode.point[j] + (endNode.point[j] - startNode.point[j]) * frac),
        firstOutputSlot + i
      );
      this.pixels.push(pixel);
    }
  }
}

function buildModel() {
  let inchesPerMeter = 39.3701;

  // These are all in inches, but the actual coordinate system will be meters
  let rafterSpacing = [31.5, 32.5, 31.25, 32.2, 33, 30];
  let rafterLength = 3 * inchesPerMeter;
  let rafterHeight = 7;
  let pixelsPerRafter = 60 * 3; // 3 meters of 60 LED/meter pixel tape

  let cumulativeDistance = 0;
  let cumulativeOutputSlot = 0;
  for (let rafter = 0; rafter <= rafterSpacing.length; rafter ++) {
    for (let side = 0; side < 2; side ++) {
      let start = new Node([cumulativeDistance / inchesPerMeter, 0, side * rafterHeight]);
      let end = new Node([cumulativeDistance / inchesPerMeter, rafterLength, side * rafterHeight]);
      new Edge(start, end, pixelsPerRafter, cumulativeOutputSlot);
      cumulativeOutputSlot += pixelsPerRafter;
    }

    cumulativeDistance += rafterSpacing; // will reference past end in final iteration
  }
}
   
/*****************************************************************************/
/* E131 output                                                               */
/*****************************************************************************/

import { default as e131 } from 'e131';

// 10.2.0.8 is geoff-f48-2.int.monument.house
// We hardcode the IP because if we don't, a bug somewhere causes a DNS
// lookup for each and every e131 packet sent. This is a "good enough" fix
var e131Client = new e131.Client('10.2.0.8');  // or use a universe

function sendFrame(buffer) {
  return new Promise(resolve => {
    var i = 0;
    var pos = 0;

    var startUniverse = 1;
    var thisUniverse = startUniverse;
    var channelsPerUniverse = 510;
    var packets = [];
    var totalChannels = buffer.length;
    for (let idx = 0; idx < totalChannels; ) {
      var theseChannels = Math.min(totalChannels - idx, channelsPerUniverse);
      var p = e131Client.createPacket(theseChannels);
      p.setSourceName('sandestin');
      p.setUniverse(thisUniverse);
      p.setPriority(p.DEFAULT_PRIORITY);  // not strictly needed, done automatically
      packets.push(p);
      idx += theseChannels;
      thisUniverse ++;
    }
    
    function sendNextPacket() {
      if (i === packets.length) {
        resolve();
      } else {
        var p = packets[i];
        i += 1;
        var slotsData = p.getSlotsData();
        buffer.copy(slotsData, 0, pos);
        pos += slotsData.length;
        e131Client.send(p, sendNextPacket);
      }
    } 

    sendNextPacket();
  });
}

/*****************************************************************************/
/* Frame rendering                                                           */
/*****************************************************************************/

import { default as rgb } from 'hsv-rgb';

async function renderFrame(frame) {
  var buf = Buffer.alloc(pixels.length * channelsPerPixel);
  var pixelsPerSide = 60*3;
  var sidesPerRafter = 2;
  var numRafters = 7;
  
  let patternSpeed = .5;
  let patternWidth = .5;
  
  let hueCenter = (frame.displayTime / 1000.0 * patternSpeed) % 1.0;
  var hueStart = hueCenter - patternWidth / 2 + 1.0;
  var hueEnd = hueCenter + patternWidth / 2 + 1.0;
  var hueStep = (hueEnd - hueStart) / 240;

  var pixel = -1;
  var side = 0;
  var rafter = 0;

  var totalChannels = pixels.length * channelsPerPixel;
  for (var idx = 0; idx < totalChannels; idx += channelsPerPixel) {
    pixel++;
    if (pixel === pixelsPerSide) {
      pixel = 0;
      side++;
      if (side === sidesPerRafter) {
        side = 0;
        rafter++;
      }
    }

    let color = rgb(((hueStart + pixel * hueStep + rafter/8.0) % 1) * 360,
      100 /* saturation */, 100 /* brightness */);

    buf[idx + 0] = Math.min(color[1], 255); // green
    buf[idx + 1] = Math.min(color[0], 255); // red
    buf[idx + 2] = Math.min(color[2], 255); // blue
    buf[idx + 3] = 0; // warm white
  }

  await sendFrame(buf);
}

/*****************************************************************************/
/* Main loop                                                                 */
/*****************************************************************************/

class Frame {
  constructor(index, displayTime) {
    this.index = index;
    this.displayTime = displayTime;
  }
}

async function main() {
  buildModel();
  console.log(`Model has ${nodes.length} nodes, ${edges.length} edges, and ${pixels.length} pixels`);

  let framesPerSecond = 40;
  let msPerFrame = 1000.0 / framesPerSecond;
  let lastFrameIndex = null;
  let startTime = Date.now();
  while (true) {
    // We should redo this at some point so that displayTime is actually the time the frame's
    // going to be displayed (for music sync purposes). Currently it's actually the time the
    // frame is rendered.
    let msSinceStart = (Date.now() - startTime);
    let frameIndex = Math.floor(msSinceStart / msPerFrame) + 1;
    let displayTime = startTime + frameIndex * msPerFrame;
    let frame = new Frame(frameIndex, displayTime);
    await sleep(displayTime - Date.now());

    await renderFrame(frame);

    if (lastFrameIndex !== null && lastFrameIndex !== frameIndex - 1) {
      console.log(`warning: skipped frames from ${lastFrameIndex} to ${frameIndex}`);
    }
    lastFrameIndex = frameIndex;
  }
}

await main();
