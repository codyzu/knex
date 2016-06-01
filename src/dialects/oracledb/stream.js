
/*jslint node:true, nomen: true*/
var inherits = require('inherits')
var Readable = require('stream').Readable

import {merge} from 'lodash'

function OracleQueryStream(connection, sql, bindings, options) {
  Readable.call(this, merge({}, {
    objectMode: true,
    highWaterMark: 1000
  }, options))
  this.oracleReader = connection.queryStream(sql, bindings || [])
}
inherits(OracleQueryStream, Readable)

OracleQueryStream.prototype._read = function() {
  var pushNull = () => {
    process.nextTick(() => {
      this.push(null)
    })
  }
  try {
    this.oracleReader.nextRows((err, rows) => {
      if (err) return this.emit('error', err)
      if (rows.length === 0) {
        pushNull()
      } else {
        for (var i = 0; i < rows.length; i++) {
          if (rows[i]) {
            this.push(rows[i])
          } else {
            pushNull()
          }
        }
      }
    })
  } catch (e) {
    // Catch Error: invalid state: reader is busy with another nextRows call
    // and return false to rate limit stream.
    if (e.message ===
      'invalid state: reader is busy with another nextRows call') {
      return false
    } else {
      this.emit('error', e)
    }
  }
}

module.exports = OracleQueryStream
