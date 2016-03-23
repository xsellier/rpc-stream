'use strict'

const through = require('through')
const serialize = require('stream-serializer')()

const MISSING_CALLBACK = -1

const expandError = function(err) {
  if (err && err.message) {
    err = Object.assign(new Error(err.message), err)
  }

  return err
}

const callable = function(obj, key) {
  return function(args, callback) {
    return obj[key].apply(obj, callback ? args.concat(callback) : args)
  }
}

module.exports = function(obj, opts) {
  if (/(true|false)/i.test(opts)) {
    opts = { raw: opts }
  } else {
    opts = opts || {}
  }

  let callbackList = {}
  let currentCallbackIndex = 1
  let local = obj || {}

  let flattenError = opts.flattenError || function(err) {
    if (err instanceof Error) {
      // format error
      err = Object.assign({ message: err.message }, err)
    }

    return err
  }

  if (obj) {
    local = {}

    Object.keys(obj).forEach((key) => {
      local[key] = callable(obj, key)
    })
  }

  const stream = through(function(data) {
    // write - on incoming call
    data = data.slice()

    let callbackIndex = data.pop()
    let args = data.pop(), name = data.pop()

    // if(~callbackIndex) then there was no callback.
    if (args[0]) {
      args[0] = expandError(args[0])
    }

    if (name != null) {
      let called = false
      const callback = function() {
        if (called) {
          return
        }

        called = true

        let args = [].slice.call(arguments)

        args[0] = flattenError(args[0])

        // responses don't have a name.
        if (~callbackIndex) {
          stream.emit('data', [args, callbackIndex])
        }
      }

      try {
        local[name].call(obj, args, callback)
      } catch (err) {
        if (~callbackIndex) {
          stream.emit('data', [[flattenError(err)], callbackIndex])
        }
      }
    } else if (!callbackList[callbackIndex]) {
      // there is no callback with that id.
      // either one end mixed up the id or
      // it was called twice.
      // log this error, but don't throw.
      // this process shouldn't crash because another did wrong
      let invalidCallbackIdErr = new Error(`Invalid callback id (${id}, ${data})`)

      stream.emit('error', invalidCallbackIdErr)

      return invalidCallbackIdErr
    } else {
      // call the callback.
      let callback = callbackList[callbackIndex]

      // delete callback before calling it, incase callback throws.
      delete callbackList[callbackIndex]

      callback.apply(null, args)
    }
  })

  const rpc = stream.rpc = function(name, args, callback) {
    if (callback) {
      callbackList[++currentCallbackIndex] = callback
    }

    if ('string' !== typeof name) {
      throw new Error(`'name' *must* be string, ${name}`)
    }

    stream.emit('data', [name, args, callback ? currentCallbackIndex : MISSING_CALLBACK])

    if (callback && currentCallbackIndex >= Number.MAX_SAFE_INTEGER) {
      // reset if max
      currentCallbackIndex = 0
    }

    // that is 900 million million.
    // if you reach that, dm me,
    // callbackIndex'll buy you a beer. @dominictarr
  }

  stream.createRemoteCall = function(name) {
    return function() {
      var args = [].slice.call(arguments)
      var callback = ('function' === typeof args[args.length - 1]) ? args.pop() : null

      rpc(name, args, callback)
    }
  }

  stream.createLocalCall = function(name, fn) {
    local[name] = fn
  }

  stream.wrap = function(remote) {
    let wrappedFunctions = {}

    if (!Array.isArray(remote)) {
      if ('string' === typeof remote) {
        remote = [remote]
      } else {
        remote = Object.keys(remote)
      }
    }

    remote.forEach(function(key) {
      wrappedFunctions[key] = stream.createRemoteCall(key)
    })

    return wrappedFunctions
  }

  if (opts.raw) {
    return stream
  }

  return serialize(stream)
}
