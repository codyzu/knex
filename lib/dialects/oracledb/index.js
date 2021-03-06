
// Oracledb Client
// -------
'use strict';

var _ = require('lodash');
var inherits = require('inherits');
var Client_Oracle = require('../oracle');
var QueryCompiler = require('./query/compiler');
var ColumnCompiler = require('./schema/columncompiler');
var Formatter = require('./formatter');
var BlobHelper = require('./utils').BlobHelper;
var ReturningHelper = require('./utils').ReturningHelper;
var Promise = require('../../promise');
var stream = require('stream');
var helpers = require('../../helpers');
var Transaction = require('./transaction');

function Client_Oracledb() {
  Client_Oracle.apply(this, arguments);
  // Node.js only have 4 background threads by default, oracledb needs one by connection
  if (this.driver) {
    process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || 1;
    process.env.UV_THREADPOOL_SIZE += this.driver.poolMax;
  }
}
inherits(Client_Oracledb, Client_Oracle);

Client_Oracledb.prototype.driverName = 'oracledb';

Client_Oracledb.prototype._driver = function () {
  var oracledb = require('oracledb');
  return oracledb;
};

Client_Oracledb.prototype.QueryCompiler = QueryCompiler;
Client_Oracledb.prototype.ColumnCompiler = ColumnCompiler;
Client_Oracledb.prototype.Formatter = Formatter;
Client_Oracledb.prototype.Transaction = Transaction;

Client_Oracledb.prototype.prepBindings = function (bindings) {
  var self = this;
  return _.map(bindings, function (value) {
    if (value instanceof BlobHelper && self.driver) {
      return { type: self.driver.BLOB, dir: self.driver.BIND_OUT };
      // Returning helper always use ROWID as string
    } else if (value instanceof ReturningHelper && self.driver) {
        return { type: self.driver.STRING, dir: self.driver.BIND_OUT };
      } else if (typeof value === 'boolean') {
        return value ? 1 : 0;
      } else if (value === undefined) {
        return self.valueForUndefined;
      }
    return value;
  });
};

// Get a raw connection, called by the `pool` whenever a new
// connection needs to be added to the pool.
Client_Oracledb.prototype.acquireRawConnection = function () {
  var client = this;
  var asyncConnection = new Promise(function (resolver, rejecter) {
    client.driver.getConnection({
      user: client.connectionSettings.user,
      password: client.connectionSettings.password,
      connectString: client.connectionSettings.host + '/' + client.connectionSettings.database
    }, function (err, connection) {
      if (err) return rejecter(err);
      if (client.connectionSettings.prefetchRowCount) {
        connection.setPrefetchRowCount(client.connectionSettings.prefetchRowCount);
      }

      connection.commitAsync = function () {
        var self = this;
        return new Promise(function (commitResolve, commitReject) {
          if (asyncConnection.isTransaction) {
            return commitResolve();
          }
          self.commit(function (err) {
            if (err) {
              return commitReject(err);
            }
            commitResolve();
          });
        });
      };
      connection.rollbackAsync = function () {
        var self = this;
        return new Promise(function (rollbackResolve, rollbackReject) {
          self.rollback(function (err) {
            if (err) {
              return rollbackReject(err);
            }
            rollbackResolve();
          });
        });
      };
      var fetchAsync = function fetchAsync(sql, bindParams, options, cb) {
        options = options || {};
        options.outFormat = client.driver.OBJECT;
        if (options.resultSet) {
          connection.execute(sql, bindParams || [], options, function (err, result) {
            if (err) {
              return cb(err);
            }
            var fetchResult = { rows: [], resultSet: result.resultSet };
            var numRows = 100;
            var fetchRowsFromRS = function fetchRowsFromRS(connection, resultSet, numRows) {
              resultSet.getRows(numRows, function (err, rows) {
                if (err) {
                  resultSet.close(function () {
                    return cb(err);
                  });
                } else if (rows.length === 0) {
                  return cb(null, fetchResult);
                } else if (rows.length > 0) {
                  if (rows.length === numRows) {
                    fetchResult.rows = fetchResult.rows.concat(rows);
                    fetchRowsFromRS(connection, resultSet, numRows);
                  } else {
                    fetchResult.rows = fetchResult.rows.concat(rows);
                    return cb(null, fetchResult);
                  }
                }
              });
            };
            fetchRowsFromRS(connection, result.resultSet, numRows);
          });
        } else {
          connection.execute(sql, bindParams || [], options, cb);
        }
      };
      connection.executeAsync = function (sql, bindParams, options) {
        // Read all lob
        return new Promise(function (resultResolve, resultReject) {
          fetchAsync(sql, bindParams, options, function (err, results) {
            if (err) {
              return resultReject(err);
            }
            // Collect LOBs to read
            var lobs = [];
            if (results.rows) {
              if (Array.isArray(results.rows)) {
                for (var i = 0; i < results.rows.length; i++) {
                  // Iterate through the rows
                  var row = results.rows[i];
                  for (var column in row) {
                    if (row[column] instanceof stream.Readable) {
                      lobs.push({ index: i, key: column, stream: row[column] });
                    }
                  }
                }
              }
            }
            Promise.each(lobs, function (lob) {
              return new Promise(function (lobResolve, lobReject) {

                readStream(lob.stream, function (err, d) {
                  if (err) {
                    if (results.resultSet) {
                      results.resultSet.close(function () {
                        return lobReject(err);
                      });
                    }
                    return lobReject(err);
                  }
                  results.rows[lob.index][lob.key] = d;
                  lobResolve();
                });
              });
            }).then(function () {
              if (results.resultSet) {
                results.resultSet.close(function (err) {
                  if (err) {
                    return resultReject(err);
                  }
                  return resultResolve(results);
                });
              }
              resultResolve(results);
            }, function (err) {
              resultReject(err);
            });
          });
        });
      };
      resolver(connection);
    });
  });
  return asyncConnection;
};

// Used to explicitly close a connection, called internally by the pool
// when a connection times out or the pool is shutdown.
Client_Oracledb.prototype.destroyRawConnection = function (connection, cb) {
  connection.release(cb);
};

// Runs the query on the specified connection, providing the bindings
// and any other necessary prep work.
Client_Oracledb.prototype._query = function (connection, obj) {
  // Convert ? params into positional bindings (:1)
  obj.sql = this.positionBindings(obj.sql);
  obj.bindings = this.prepBindings(obj.bindings) || [];

  return new Promise(function (resolver, rejecter) {
    if (!obj.sql) {
      return rejecter(new Error('The query is empty'));
    }
    var options = { autoCommit: false };
    if (obj.method === 'select') {
      options.resultSet = true;
    }
    connection.executeAsync(obj.sql, obj.bindings, options).then(function (response) {
      // Flatten outBinds
      var outBinds = _.flatten(response.outBinds);
      obj.response = response.rows || [];
      obj.rowsAffected = response.rows ? response.rows.rowsAffected : response.rowsAffected;

      if (obj.method === 'update') {
        var modifiedRowsCount = obj.rowsAffected.length || obj.rowsAffected;
        var updatedObjOutBinding = [];
        var updatedOutBinds = [];
        var updateOutBinds = function updateOutBinds(value, index) {
          OutBindsOffset = index * modifiedRowsCount;
          updatedOutBinds.push(outBinds[i + OutBindsOffset]);
        };

        for (var i = 0; i < modifiedRowsCount; i++) {
          updatedObjOutBinding.push(obj.outBinding[0]);
          var OutBindsOffset = 0;
          _.each(obj.outBinding[0], updateOutBinds);
        }
        outBinds = updatedOutBinds;
        obj.outBinding = updatedObjOutBinding;
      }

      if (!obj.returning && outBinds.length === 0) {
        return connection.commitAsync().then(function () {
          resolver(obj);
        });
      }
      var rowIds = [];
      var offset = 0;
      Promise.each(obj.outBinding, function (ret, line) {
        offset = offset + (obj.outBinding[line - 1] ? obj.outBinding[line - 1].length : 0);
        return Promise.each(ret, function (out, index) {
          return new Promise(function (bindResolver, bindRejecter) {
            if (out instanceof BlobHelper) {
              var blob = outBinds[index + offset];
              if (out.returning) {
                obj.response[line] = obj.response[line] || {};
                obj.response[line][out.columnName] = out.value;
              }
              blob.on('error', function (err) {
                bindRejecter(err);
              });
              blob.on('finish', function () {
                bindResolver();
              });
              blob.write(out.value);
              blob.end();
            } else if (obj.outBinding[line][index] === 'ROWID') {
              rowIds.push(outBinds[index + offset]);
              bindResolver();
            } else {
              obj.response[line] = obj.response[line] || {};
              obj.response[line][out] = outBinds[index + offset];
              bindResolver();
            }
          });
        });
      }).then(function () {
        return connection.commitAsync();
      }).then(function () {
        if (obj.returningSql) {
          return connection.executeAsync(obj.returningSql(), rowIds, { resultSet: true }).then(function (response) {
            obj.response = response.rows;
            return obj;
          }, rejecter);
        }
        return obj;
      }, rejecter).then(function (obj) {
        resolver(obj);
      });
    }, rejecter);
  });
};

// Handle clob
function readStream(stream, cb) {
  var oracledb = require('oracledb');
  var data = '';

  if (stream.iLob.type === oracledb.CLOB) {
    stream.setEncoding('utf-8');
  } else {
    data = new Buffer(0);
  }
  stream.on('error', function (err) {
    cb(err);
  });
  stream.on('data', function (chunk) {
    if (stream.iLob.type === oracledb.CLOB) {
      data += chunk;
    } else {
      data = Buffer.concat([data, chunk]);
    }
  });
  stream.on('end', function () {
    cb(null, data);
  });
}

// Process the response as returned from the query.
Client_Oracledb.prototype.processResponse = function (obj, runner) {
  var response = obj.response;
  var method = obj.method;
  if (obj.output) {
    return obj.output.call(runner, response);
  }
  switch (method) {
    case 'select':
    case 'pluck':
    case 'first':
      response = helpers.skim(response);
      if (obj.method === 'pluck') response = _.pluck(response, obj.pluck);
      return obj.method === 'first' ? response[0] : response;
    case 'insert':
    case 'del':
    case 'update':
    case 'counter':
      if (obj.returning) {
        if (obj.returning.length === 1 && obj.returning[0] !== '*') {
          return _.flatten(_.map(response, _.values));
        }
        return response;
      } else if (!_.isUndefined(obj.rowsAffected)) {
        return obj.rowsAffected;
      } else {
        return 1;
      }
      break;
    default:
      return response;
  }
};

module.exports = Client_Oracledb;