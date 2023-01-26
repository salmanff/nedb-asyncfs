var should = require('chai').should()
  , assert = require('chai').assert
  , testFolder = 'workspace/filetests'
  , testFs = testFolder + '/test.txt'
  , renamedFileName = 'renamed-test.txt'
  , innerFolder = 'inner'
  // , fs = require('fs') // sf_added removed
  , path = require('path')
  , _ = require('underscore')
  , async = require('async')
  ;


/**
@sf_added:
  - this tests the file system

**/
var env = null
//env = require('../env/params')
env = require('../env/params')
try {
  env = require('../env/params')
} catch(e) {
  env = {dbFS:null, name:'defaultLocalFS'}
  // onsole.log("no custom environment - Useing local fs")
}
console.log(" Using file system enviornment: "+env.name)
const BEFORE_DELAY = (env.name == 'dropbox' || env.name == 'googleDrive' || env.name == 'fdsFairOs') ? 1000 :
  ((env.name == 'aws')? 500: 0);
  // dbx mostly works with 500, except for 1 case when writing 100 files
const BEFORE_DELAY0 = (env.name == 'dropbox' || env.name == 'googleDrive' || env.name == 'fdsFairOs') ? 500 : 0;

const WRITE_TEXT = 'hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello hello world hello end'

describe('FS', function () {
  var dbfs;

  beforeEach(function (done) {
      dbfs = env.dbFS

      async.waterfall([
        function (cb) {
          if (dbfs && dbfs.initFS) {
            dbfs.initFS(cb)
          } else {
            cb(null)
          }
        }
      ], done);
  });

  it('initialises', function  (done) {
    dbfs.isPresent(testFs, function (err, exists) {
      if (err) throw err
      if (exists) {
        dbfs.unlink(testFs, function(err) {
          if (err) throw err
          done()
          // setTimeout(function() {return cb();},BEFORE_DELAY)
        });
      } else {
        done()
      }
    });
  });

  it('has functions', function (done) {
    assert.isNotNull(dbfs.readdir)
    assert.isNotNull(dbfs.readFile)
    assert.isNotNull(dbfs.unlink)
    assert.isNotNull(dbfs.rename)
    assert.isNotNull(dbfs.writeFile)
    assert.isNotNull(dbfs.isPresent)
    assert.isNotNull(dbfs.mkdirp)
    done();
  });

  it('can write and assert presence', function (done) {
    dbfs.writeFile(testFs, WRITE_TEXT, {}, function (err) {
      assert.isNull(err)
      dbfs.isPresent(testFs, function (err, exists) {
        if (err) throw err
        assert(exists === true)
        dbfs.isPresent(testFs, function (err, present) {
          assert(!err && present === true)
          dbfs.isPresent('/workplace/doesntexist.txt', function (err, present) {
            assert(!err && present === false)
            done()
          })
        })
      })
    })
  })


  it('can read file', function (done) {
    dbfs.readFile(testFs, {}, function (err, res) {
      assert.isNull(err);
      assert.isNotNull(res);
      res.should.equal(WRITE_TEXT)
      done();
    })
  });

  it('can rename', function (done) {
    var renamedPath = testFolder + '/' + renamedFileName
    async.waterfall([
      function (cb) {
        dbfs.rename(testFs, renamedPath , cb)
      },
      function(cb) {
        dbfs.isPresent(renamedPath, function (err, exists) {
          if (err) throw err
          assert(exists === true)
          cb()
        })
      },
      function(cb) {
        dbfs.isPresent(testFs, function (err, exists) {
          if (err) throw err
          assert(exists === false)
          cb()
        })
      },
      function(cb) {
        dbfs.readFile(renamedPath, {}, function (err, contents) {
          assert.isNull(err);
          assert.isNotNull(contents);
          contents.should.equal(WRITE_TEXT)
          cb()
        })
      }
    ], function(err) {
      if (!err) err = null
      assert.isNull(err);
      done()
    })
  })

  // it should overwrite or give error when donot overwirte option is included

  it('can read directories and files and remove them', function (done) {
    const pathToInner = testFolder + '/' + innerFolder
    async.waterfall([
      function (cb) {
        dbfs.mkdirp(pathToInner, cb)
      },
      function (stuff, cb) {
        cb(null)
      },
      function (cb) {
        dbfs.readdir(testFolder, null, cb)
        // read directories
      },
      function (files, cb) {
        let canReadFolders = true
        if (files.indexOf(innerFolder) < 0) {
          canReadFolders = false
          console.warn('NOTE: It is best to list folders within subfolders where possible')
        }
        assert((files.indexOf(renamedFileName) >= 0) === true)
        files.length.should.equal((canReadFolders ? 2 : 1))
        // assert that the renamed file and the dir exist
        cb(null)
      },
      function (cb) {
        dbfs.stat(pathToInner, function (err, folderstats) {
          if (err) console.warn('folder stats error: ', err.message)
          if (!folderstats) console.warn('It is best to return folder stats if storage system provides it')
          if (folderstats) {
            if (folderstats.type !== 'dir') console.warn('It is best to mark a fodler type as "dir" if possible')
            if (!folderstats.atimeMs || !folderstats.mtimeMs || !folderstats.birthtimeMs) {
              console.warn('Missing time variables - recommended to have atimeMs, mtimeMs, and birthtimeMs')
            }
          }
          cb(null)
        })
      },
      function (cb) {
        dbfs.stat(testFolder + '/' + renamedFileName, cb)
      },
      function (filestats, cb) {
        assert(filestats.type === 'file')
        if (!filestats.size || !filestats.atimeMs || !filestats.mtimeMs || !filestats.birthtimeMs) {
          console.warn('Missing time variables - recommended to have atimeMs, mtimeMs, and birthtimeMs')
        }
        cb(null)
      },
      function (cb) {
        cb(null)
      },
      function (cb) {
        dbfs.removeFolder(pathToInner, cb)
      },
      function (cb) {
        dbfs.unlink((testFolder + '/' + renamedFileName), cb)
      },
      function (cb) {
        dbfs.readdir(testFolder, null, cb)
      },
      function (emptyFiles, cb) {
        // assert empty
        emptyFiles.length.should.equal(0)
        cb(null)
      }
    ], function (err) {
      if (!err) err = null
      assert.isNull(err)
      done()
    })
  })

  it('gives error when try to get stats on inexistant file', function (done) {
    dbfs.stat(testFolder + '/fileDoesNtExist.txt', function (err, res) {
      // onsole.log(err, res)
      assert.isNotNull(err)
      assert(res === undefined)
      done()
    })
  })

})
