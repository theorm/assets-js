var fmt = require("util").format
  , _ = require("lodash")
  , less = require("less")
  , uglifyjs = require("uglify-js")
  , Promise = require("bluebird")
  , fs = Promise.promisifyAll(require("fs"))
  , path = require("path")
  , knox = require("knox")
  , CleanCSS = require("clean-css")
  , readdirRecursive = Promise.promisify(require("recursive-readdir"))
  , mime = require('mime')
  , git = require('git-rev');

var SCRIPT_TAG = "<script src=\"%s/%s\"></script>"
var LESS_TAG = "<link rel=\"stylesheet/less\" type=\"text/css\" href=\"%s/%s\" />"
var LESS_LIBRARY_TAG = "<script src=\"//cdnjs.cloudflare.com/ajax/libs/less.js/1.7.0/less.min.js\"></script>"
var CSS_TAG = "<link rel=\"stylesheet\" href=\"%s/%s\">";

var cachebuster = (new Date()).getTime();

git.long(function (str) {
  if (str) cachebuster = str;
})


var Assets = function(options) {
  this.options = options;
}

Assets.prototype.js = function(name) {
  if (this.options.production) {
    var f = 'js/' + name + '.js';
    if (this.options.cdn.useCachebuster)
      f = f + "?v=" + cachebuster;
    return fmt(SCRIPT_TAG, this.options.cdn.prefix, f);
  }

  var files = this.options.assets.js[name] || [];
  return _.map(files, function(f) { return fmt(SCRIPT_TAG, this.options.localPrefix, f); }, this).join("\n");
}

Assets.prototype.less = function(name) {
  if (this.options.production) {
    var f = 'css/' + name + '.css';
    if (this.options.cdn.useCachebuster)
      f = f + "?v=" + cachebuster;

    return fmt(CSS_TAG, this.options.cdn.prefix, f);
  }

  var files = this.options.assets.less[name] || [];
  var tags = _.map(files, function(f) { return fmt(LESS_TAG, this.options.localPrefix, f); }, this);
  tags.push(LESS_LIBRARY_TAG);
  return tags.join("\n");
}

Assets.prototype.css = function(name) {
  if (this.options.production) {
    var f = 'css/' + name + '.css';
    if (this.options.cdn.useCachebuster)
      f = f + "?v=" + cachebuster;

    return fmt(CSS_TAG, this.options.cdn.prefix, f);
  }

  var files = this.options.assets.css[name] || [];
  var tags = _.map(files, function(f) { return fmt(CSS_TAG, this.options.localPrefix, f); }, this);
  return tags.join("\n");
}

Assets.prototype.getStaticPrefix = function() {
  if (this.options.production) {
    return this.options.cdn.prefix;
  }

  return this.options.localPrefix;
}

Assets.prototype.setProduction = function(yesno) {
  this.options.production = yesno;
}

Assets.prototype.compileLess = function(name, callback) {

  var files = this.options.assets.less[name] || [];
  var buffers = [];
  var errorReported = false;

  if (!files.length) return callback(null, new Buffer(""));

  _.each(files, function(f) {
    var filePath = path.join(this.options.path, f);
    fs.readFileAsync(filePath).then(function(contents) {
      var lessParser = new less.Parser({
        paths: [path.dirname(filePath)],
      });
      var parseLess = Promise.promisify(lessParser.parse, lessParser);

      return parseLess(contents.toString());
    }).then(function(lessTree) {
      buffers.push(new Buffer(lessTree.toCSS({compress: true})));

      if (buffers.length == files.length) {
        var buffer = _.reduce(buffers, function(accumulator, b) {
          return Buffer.concat([accumulator, b]);
        }, new Buffer(""));

        callback(null, buffer);
      }
    }).catch(function(e) {
      if (!errorReported) {
        callback(e);
        errorReported = true;
      }
    });
  }, this);
}

Assets.prototype.minifyJS = function(name, callback) {
  var files = this.options.assets.js[name] || [];
  var staticPath = this.options.path;
  try {
    var result = uglifyjs.minify(_.map(files, function(f) {
      return path.join(staticPath, f);
    }));
    callback(null, new Buffer(result.code));
  } catch(e) {
    callback(e);
  }
}

Assets.prototype.minifyCSS = function(name, callback) {
  var cc = new CleanCSS({keepBreaks: true});
  var cleanCSS = Promise.promisify(cc.minify, cc);
  var files = this.options.assets.css[name] || [];
  var buffers = [];
  var errorReported = false;

  if (!files.length) return callback(null, new Buffer(""));

  _.each(files, function(f) {
    var filePath = path.join(this.options.path, f);

    fs.readFileAsync(filePath).then(function(contents) {
      return cleanCSS(contents);
    }).then(function(minifiedCSS) {
      buffers.push(new Buffer(minifiedCSS));

      if (buffers.length == files.length) {
        var buffer = _.reduce(buffers, function(accumulator, b) {
          return Buffer.concat([accumulator, b]);
        }, new Buffer(""));

        callback(null, buffer);
      }
    }).catch(function(e) {
      if (!errorReported) {
        callback(e);
        errorReported = true;
      }
    });

  }, this);
}

Assets.prototype.uploadToS3 = function(path, bufferOrFile, callback) {
  var client = knox.createClient({
    key: this.options.cdn.s3key
  , secret: this.options.cdn.s3secret
  , bucket: this.options.cdn.bucket
  // , region: 'external-3'
  });

  var contentType = mime.lookup(path);

  console.log('uploading %s', path);

  var resultCallback = function(err, res) {
    if (err) callback(err, res);
    else if (res.statusCode < 200 || res.statusCode >= 300) {
      callback(new Error('Status: ' + res.statusCode), res);
    } else callback(null, res);
  }

  if (Buffer.isBuffer(bufferOrFile)) {
    client.putBuffer(bufferOrFile, path, {'Content-Type': contentType}, resultCallback);
  } else {
    client.putFile(bufferOrFile, path, {'Content-Type': contentType}, resultCallback);
  }
}

Assets.prototype.compileAndUploadToCDN = function(callback) {
  var uploadToCDN = Promise.promisify(this.uploadToS3, this);
  var minifyJS = Promise.promisify(this.minifyJS, this);
  var minifyCSS = Promise.promisify(this.minifyCSS, this);
  var compileLess = Promise.promisify(this.compileLess, this);

  var processJS = Promise.all(_.map(_.keys(this.options.assets.js), function(name) {
    return minifyJS(name).then(function(buf) {
      return uploadToCDN('/js/' + name + '.js', buf);
    });
  }, this));

  var processCSS = Promise.all(_.map(_.keys(this.options.assets.css), function(name) {
    return minifyCSS(name).then(function(buf) {
      return uploadToCDN('/css/' + name + '.css', buf);
    });
  }, this));

  var processLess = Promise.all(_.map(_.keys(this.options.assets.less), function(name) {
    return compileLess(name).then(function(buf) {
      return uploadToCDN('/css/' + name + '.css', buf);
    });
  }, this));

  var processExtras = Promise.all(_.map(this.options.assets.extras, function(p) {
    var staticPath = this.options.path;

    return readdirRecursive(path.join(this.options.path, p)).then(function(files) {
      return Promise.all(_.map(files, function(f) {
        var cdnPath = f.replace(staticPath, '');
        return uploadToCDN(cdnPath, f);
      }));
    });
  }, this));

  Promise.all([
    processJS,
    processCSS,
    processLess,
    processExtras
  ]).then(function(js, css, less) {
    callback ? callback() : _.noop();
  }).catch(function(e) {
    callback ? callback(e) : _.noop();
  });
}

module.exports.Assets = Assets;

