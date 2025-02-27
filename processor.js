const fetch = require('node-fetch');
const { TXID } = require('./index');
module.exports = function (
  client,
  nextBlock = 1,
  prefix = ""
) {
  var onCustomJsonOperation = {}; // Stores the function to be run for each operation id.
  var onOperation = {};

  var onNewBlock = function () { };
  var onStreamingStart = function () { };
  var behind = 0
  var isStreaming;
  var stream;
  var blocks = {
    processing: 0,
    completed: nextBlock,
    ensure: function (last) {
      setTimeout(() => {
        if (!blocks.processing && blocks.completed == last) {
          getBlockNumber(nextBlock);
          if (!(last % 3))
            getHeadOrIrreversibleBlockNumber(function (result) {
              if (nextBlock < result - 3) {
                behind = result - nextBlock;
                beginBlockComputing();
              } else if (!isStreaming) {
                beginBlockStreaming();
              }
            });;
        };
      }, 6000)
    },
    v: {},
    manage: function (block_num, force) {
      if (blocks.processing) {
        setTimeout(() => { blocks.manage(block_num) }, 100)
        var blockNums = Object.keys(blocks);
        for (var i = 0; i < blockNums.length; i++) {
          if (
            parseInt(blockNums[i]) &&
            parseInt(blockNums[i]) < nextBlock - 1
          ) {
            delete blocks[blockNums[i]];
          }
        }
      } else if (blocks[block_num] && block_num == nextBlock) {
        blocks.processing = nextBlock;
        processBlock(blocks[block_num]).then(() => {
          nextBlock = block_num + 1;
          blocks.completed = blocks.processing;
          blocks.processing = 0
          delete blocks[block_num];
          if (blocks[nextBlock]) blocks.manage(nextBlock);
        });
      } else if (block_num > nextBlock) {
        if (blocks[nextBlock]) {
          processBlock(blocks[nextBlock]).then(() => {
            delete blocks[nextBlock];
            nextBlock++;
            blocks.completed = blocks.processing;
            blocks.processing = 0;
            if (blocks[nextBlock]) blocks.manage(nextBlock);
          });
        } else if (!blocks[nextBlock]) {
          getBlock(nextBlock);
        }
        if (!isStreaming || behind < 5) {
          getHeadOrIrreversibleBlockNumber(function (result) {
            if (nextBlock < result - 3) {
              behind = result - nextBlock;
              beginBlockComputing();
            } else if (!isStreaming) {
              beginBlockStreaming();
            }
          });
        }
      }
      blocks.ensure(block_num);
    }
  }
  var stopping = false;

  // Returns the block number of the last block on the chain or the last irreversible block depending on mode.
  function getHeadOrIrreversibleBlockNumber(callback) {
    client.database.getDynamicGlobalProperties().then(function (result) {
      callback(result.last_irreversible_block_num);
    });
  }

  function getVops(bn) {
    return new Promise((resolve, reject) => {
      fetch(client.currentAddress, {
        body: `{"jsonrpc":"2.0", "method":"condenser_api.get_ops_in_block", "params":[${bn},true], "id":1}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      })
        .then((res) => res.json())
        .then((json) => {
          if (!json.result) {
            blocks.v[bn] = []
          } else {
            blocks.v[bn] = json.result
          }
        })
        .catch((err) => {
          console.log('Failed to get Vops for block: ', bn, err)
        });
    });
  }

  function isAtRealTime(computeBlock) {
    getHeadOrIrreversibleBlockNumber(function (result) {
      if (nextBlock >= result) {
        beginBlockStreaming();
      } else {
        behind = result - nextBlock;
        computeBlock();
      }
    });
  }

  function getBlockNumber(bln) {
    client.database
      .getBlock(bln)
      .then((result) => {
        blocks[parseInt(result.block_id.slice(0, 8), 16)] = result;
        blocks.manage(bln);
      })

  }

  function getBlock(bn) {
    if (behind && !stopping) gbr(bn, behind > 100 ? 100 : behind, 0);
    else if (!stopping) gb(bn, 0);
    function gb(bln, at) {
      if (bln < TXID.saveNumber + 50) {
        client.database
          .getBlock(bln)
          .then((result) => {
            blocks[parseInt(result.block_id.slice(0, 8), 16)] = result;
            blocks.manage(bln);
          })
          .catch((err) => {
            if (at < 3) {
              gb(bn, at + 1);
            } else {
              reject(err);
            }
          });
      } else {
        setTimeout(() => {
          gb(bln, at);
        }, 1000);
      }
    }
    function gbr(bln, count, at) {
      if (bln > TXID.saveNumber + 150)
        setTimeout(() => {
          gbr(bln, count, at);
        }, 2000);
      else
        fetch(client.currentAddress, {
          body: `{"jsonrpc":"2.0", "method":"block_api.get_block_range", "params":{"starting_block_num": ${bln}, "count": ${count}}, "id":1}`,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        })
          .then((res) => res.json())
          .then((result) => {
            var Blocks = result.result.blocks;
            for (var i = 0; i < Blocks.length; i++) {
              const bkn = parseInt(Blocks[i].block_id.slice(0, 8), 16);
              for (var j = 0; j < Blocks[i].transactions.length; j++) {
                Blocks[i].transactions[j].block_num = bkn;
                Blocks[i].transactions[j].transaction_id =
                  Blocks[i].transaction_ids[j];
                Blocks[i].transactions[j].transaction_num = j;
                var ops = [];
                for (
                  var k = 0;
                  k < Blocks[i].transactions[j].operations.length;
                  k++
                ) {
                  ops.push([
                    Blocks[i].transactions[j].operations[k].type.replace(
                      "_operation",
                      ""
                    ),
                    Blocks[i].transactions[j].operations[k].value,
                  ]);
                }
                Blocks[i].transactions[j].operations = ops;
                blocks[bkn] = Blocks[i];
              }
            }
            blocks.manage(bln);
            if(behind > 100)gbr(bln + 100, behind > 200 ? 100 : 200 - behind, at);
          })
          .catch((err) => {
            if (at < 3) {
              gb(bn, at);
            } else {
              console.log('Get block range error', err)
            }
          });
    }
  }

  function beginBlockComputing() {
    var blockNum = nextBlock; // Helper variable to prevent race condition
    // in getBlock()
    blocks.ensure(nextBlock)
    //var vops = getVops(blockNum);
    getBlock(blockNum)
  }

  function beginBlockStreaming() {
    isStreaming = true;
    onStreamingStart();
    stream = client.blockchain.getBlockStream();
    stream.on("data", function (Block) {
      var blockNum = parseInt(Block.block_id.slice(0, 8), 16)
      blocks[blockNum] = Block
      blocks.manage(blockNum);
    });
    stream.on("end", function () {
      console.error(
        "Block stream ended unexpectedly. Restarting block computing."
      );
      beginBlockComputing();
      stream = undefined;
    });
    stream.on("error", function (err) {
      beginBlockComputing();
      stream = undefined;
      console.log("This place:", err);
      //throw err;
    });
  }

  function transactional(ops, i, pc, num, block, vops) {
    if (ops.length) {
      doOp(ops[i], [ops, i, pc, num, block, vops])
        .then((v) => {
          if (ops.length > i + 1) {
            transactional(v[0], v[1] + 1, v[2], v[3], v[4], v[5]);
          } else {
            // if (vops) {
            //   var Vops = [];
            //   vops
            //     .then((vo) => {
            //       for (var j = 0; j < vo.length; j++) {
            //         if (onOperation[vo[j].op[0]] !== undefined) {
            //           var json = vo[j].op[1];
            //           json.block_num = vo[j].block;
            //           //json.timestamp = vo[j].timestamp
            //           json.txid = vo[j].trx_id;
            //           Vops.push([vo[j].op[0], json]);
            //         }
            //       }
            //       if (Vops.length) {
            //         transactional(Vops, 0, v[2], v[3], v[4]);
            //       } else {
            //         onNewBlock(num, v, v[4].witness_signature, {
            //           timestamp: v[4].timestamp,
            //           block_id: v[4].block_id,
            //           block_number: num,
            //         })
            //           .then((r) => {
            //             pc[0](pc[2]);
            //           })
            //           .catch((e) => {
            //             console.log(e);
            //           });
            //       }
            //     })
            //     .catch((e) => {
            //       console.log(e);
            //     });
            // } else {
            onNewBlock(num, v, v[4].witness_signature, {
              timestamp: v[4].timestamp,
              block_id: v[4].block_id,
              block_number: num,
            })
              .then((r) => {
                pc[0](pc[2]);
              })
              .catch((e) => {
                console.log(e);
              });
            // }
          }
        })
        .catch((e) => {
          console.log(e);
          pc[1](e);
        });
    } else if (parseInt(block.block_id.slice(0, 8), 16) != num) {
      pc[0]();
      console.log("double")
    } else {
      onNewBlock(num, pc, block.witness_signature, {
        timestamp: block.timestamp,
        block_id: block.block_id,
        block_number: num,
      })
        .then((r) => {
          r[0]();
        })
        .catch((e) => {
          pc[1](e);
        });
    }

    function doOp(op, pc) {
      return new Promise((resolve, reject) => {
        if (op.length == 4) {
          onCustomJsonOperation[op[0]](op[1], op[2], op[3], [
            resolve,
            reject,
            pc,
          ]);
          //console.log(op[0])
        } else if (op.length == 2) {
          onOperation[op[0]](op[1], [resolve, reject, pc]);
          //console.log(op[0])
        }
      });
    }

    function doVop(op, pc) {
      return new Promise((resolve, reject) => {
        console.log(op, pc);
        onVOperation[op[0]](op[1], [resolve, reject, pc]);
      });
    }
  }

  function processBlock(Block, Pvops) {
    return new Promise((resolve, reject) => {
      var transactions = Block.transactions;
      let ops = [];
      if (parseInt(Block.block_id.slice(0, 8), 16) === nextBlock) {
        for (var i = 0; i < transactions.length; i++) {
          for (var j = 0; j < transactions[i].operations.length; j++) {
            var op = transactions[i].operations[j];
            if (op[0] === "custom_json") {
              //console.log('check')
              if (typeof onCustomJsonOperation[op[1].id] === "function") {
                var ip = JSON.parse(op[1].json),
                  from = op[1].required_posting_auths[0],
                  active = false;
                if (
                  typeof ip === "string" ||
                  typeof ip === "number" ||
                  Array.isArray(ip)
                )
                  ip = {};
                ip.transaction_id = transactions[i].transaction_id;
                ip.block_num = transactions[i].block_num;
                ip.timestamp = Block.timestamp;
                ip.prand = Block.witness_signature;
                if (!from) {
                  from = op[1].required_auths[0];
                  active = true;
                }
                ops.push([op[1].id, ip, from, active]); //onCustomJsonOperation[op[1].id](ip, from, active);
              }
            } else if (onOperation[op[0]] !== undefined) {
              op[1].transaction_id = transactions[i].transaction_id;
              op[1].block_num = transactions[i].block_num;
              op[1].timestamp = Block.timestamp;
              op[1].prand = Block.witness_signature;
              ops.push([op[0], op[1]]); //onOperation[op[0]](op[1]);
            }
          }
        }
        transactional(ops, 0, [resolve, reject], nextBlock, Block, Pvops);
      }
    });
  }

  return {
    /*
          Determines a state update to be called when a new operation of the id
            operationId (with added prefix) is computed.
        */
    on: function (operationId, callback) {
      onCustomJsonOperation[prefix + operationId] = callback;
    },

    onOperation: function (type, callback) {
      onOperation[type] = callback;
    },

    onNoPrefix: function (operationId, callback) {
      onCustomJsonOperation[operationId] = callback;
    },

    /*
          Determines a state update to be called when a new block is computed.
        */
    onBlock: function (callback) {
      onNewBlock = callback;
    },

    start: function () {
      beginBlockComputing();
      isStreaming = false;
    },

    getCurrentBlockNumber: function () {
      return nextBlock;
    },

    isStreaming: function () {
      return isStreaming;
    },
    onStreamingStart: function (callback) {
      onStreamingStart = callback;
    },

    stop: function (callback) {
      if (isStreaming) {
        stopping = true;
        stream.pause();
        setTimeout(callback, 1000);
      } else {
        stopping = true;
        stopCallback = callback;
      }
    },
  };
};
