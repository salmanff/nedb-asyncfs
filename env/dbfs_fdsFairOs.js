// fs_obj_fdsFairOs.js 2021-12

/*

for nedb-asyncfs, each type of file system should have a file with the following functions
- Commands similar to 'fs'
  writeFile
  rename
  unlink (should be used for files only)
  exists
  stat (similar to fs.stat except it has type (dir or file) instead of isDirectory and isFile)
  readFile
  readdir
- Addional file commands
  mkdirp
  initFS (optional)
  getFileToSend
  removeFolder (like unlink for folders)
- NeDB specific
  appendNedbTableFile (mimicks functinaility without adding actually appending)
  readNedbTableFile
  deleteNedbTableFiles
  writeNedbTableFile
  crashSafeWriteNedbFile
*/

const async = require('async')
const https = require('https')
const fs = require('fs')

function fdsFairOs (credentials = {}, options = {}) {
  fdlog('fdsFairOs  - new fds credentials to set ', { credentials })
  this.credentials = credentials
  this.doNotPersistOnLoad = (options.doNotPersistOnLoad !== false)
}

fdsFairOs.prototype.name = 'fdsFairOs'

// primitives
fdsFairOs.prototype.initFS = function (callback) {
  // fdlog('fdsFairOs  - initFS ', this.credentials)
  return this.checkAuth(function (err) {
    callback(err)
  })
}
fdsFairOs.prototype.mkdirp = function (path, callback) {
  fdlog('fdsFairOs  - mkdirp ', path)
  return this.getOrMakeFolders(path, { doNotMake: false }, function (err) {
    callback(err, null)
  })
}
fdsFairOs.prototype.unlink = function (path, callback) {
  fdlog(' - fds-unlink ', path)
  // fdlog('fdsFairOs  - unlink ', path)
  const self = this

  this.checkAuth(function (err) {
    if (err) {
      felog('error checking auth in getFileToSend ', err)
      callback(err)
    } else {
      const unlinkParams = {
        pod_name: self.credentials.podname,
        file_path: ('/' + path)
      }
      const unlinkOptions = {
        hostname: self.credentials.fdsGateway,
        path: '/v1/file/delete',
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': JSON.stringify(unlinkParams).length,
          Cookie: self.cookie.text
        }
      }
      const unlinkReq = https.request(unlinkOptions, (unlinkResp) => {
        unlinkResp.on('data', (unlinkReturns) => {
          if (unlinkReturns) unlinkReturns = unlinkReturns.toString()
          unlinkReturns = JSON.parse(unlinkReturns)

          if (!unlinkReturns || unlinkReturns.code !== 200) {
            self.fileExists(path, (err2, res) => {
              if (res && (res.present || res.present === false)) {
                callback(null)
              } else {
                felog('error in unlink ing file ', { unlinkReturns })
                felog('also errin checking for prsence', err2)
                callback(new Error('fds unlink: ' + unlinkReturns.message))
              }
            })
          } else {
            fdlog('file deleted' + path)
            const localFilePath = self.credentials.tempLocalFolder + '/' + path
            if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath)
            callback(null)
          }
        })
      })
      unlinkReq.on('error', (error) => {
        felog('error in deleting file ', error)
        callback(error)
      })
      unlinkReq.write(JSON.stringify(unlinkParams))
      unlinkReq.end()
    }
  })
}
fdsFairOs.prototype.writeFile = function (path, contents, options, callback) {
  fdlog('fdsFairOs  - writefile ', path)
  // options: doNotOverWrite
  const self = this
  let folder = removeInitialSlash(path)
  folder = folder.split('/')
  const filename = folder.pop()
  folder = folder.join('/')
  folder = removeInitialSlash(folder)

  const mkdirp = require('mkdirp')
  const tempfolder = self.credentials.tempLocalFolder + '/' + folder
  const localFilePath = tempfolder + '/' + filename

  async.waterfall([
    function (cb) {
      self.checkAuth(cb)
    },
    function (cb) {
      self.fileExists(path, cb)
    },
    function (returns, cb) {
      if (returns.present && options.doNotOverWrite) {
        felog('in fds write - File exists and doNotOverWrite is set  ', { returns })
        cb(new Error('File exists and doNotOverWrite is set'))
      } else if (returns.present) {
        // delete the file
        self.unlink(path, cb)
      } else {
        self.getOrMakeFolders(folder, {}, cb)
      }
    },
    function (cb) {
      mkdirp.sync(tempfolder)
      fs.writeFile(localFilePath, contents, {}, function (err) { return cb(err) })
    },
    function (cb) {
      // write the file
      const FormData = require('form-data')
      var form = new FormData()
      form.append('pod_name', self.credentials.podname)
      form.append('dir_path', ('/' + folder))
      form.append('block_size', '1Mb')
      form.append('files', fs.createReadStream(localFilePath))

      var headers = form.getHeaders()
      headers.Cookie = self.cookie.text

      const writeOptions = {
        hostname: self.credentials.fdsGateway,
        path: '/v1/file/upload',
        method: 'POST',
        headers
      }

      const writeReq = https.request(writeOptions)
      writeReq.on('response', function (writeResp) {
        writeResp.on('data', (writeReturns) => {
          if (!writeReturns) {
            felog('error in uploading file ', { writeReturns })
            cb(new Error('fds write: Nothing returned'))
          } else {
            writeReturns = writeReturns.toString()
            writeReturns = JSON.parse(writeReturns)
            if (writeReturns.Responses && writeReturns.Responses.length > 0 && writeReturns.Responses[0].message && writeReturns.Responses[0].message.indexOf('uploaded successfully') >= 0) {
              cb(null)
            } else {
              felog('fds write message changed n write ', path, writeReturns)
              const message = (writeReturns.Responses && writeReturns.Responses.length > 0 && writeReturns.Responses[0].message) ?  writeReturns.Responses[0].message : JSON.stringify('unknown message '+ writeReturns.Responses)
              cb(new Error(message))
            }
          }
        })
        // writeResp.on('end', (writeEnd) => { console.log('end of writeResp', { writeEnd }) })
      })
      writeReq.on('error', (error) => {
        felog('error in uploading file ', error)
        cb(error)
      })
      form.pipe(writeReq)
    }
  ], function (err) {
    if (err) felog('end of dfs -write', { err })
    callback(err)
  })
}
fdsFairOs.prototype.rename = function (fromPath, toPath, callback) {
  // check exists
  fdlog('fdsFairOs  - rename ', fromPath)
  const self = this

  async.waterfall([
    function (cb) {
      self.checkAuth(cb)
    },
    function (cb) {
      self.fileExists(fromPath, cb)
    },
    function (results, cb) {
      if (!results || !results.present) {
        cb(new Error('could not retrieve file'))
      } else {
        self.getFileToSend(fromPath, cb)
      }
    },
    function (file, cb) {
      // write to new name - do overwrite
      self.writeFile(toPath, file, { doNotOverWrite: false }, cb)
    },
    function (cb) {
      // delete old file
      self.unlink(fromPath, cb)
    }
  ], function (err) {
    if (err) felog('... dfs end of rename ', { err })
    callback(err)
  })
}
fdsFairOs.prototype.readFile = function (path, options, callback) {
  fdlog('fdsFairOs  - readFile ', path)
  this.getFileToSend(path, function (err, returns) {
    fdlog('got readfile returns ', { err, returns })
    if (err) {
      callback(err)
    } else {
      callback(null, returns.toString())
    }
  })
}
fdsFairOs.prototype.readdir = function (dirpath, options, callback) {
  // no options used
  fdlog('fds reading dir ', dirpath)
  /* sample output from dfs
  { "dirs": [ {"name": "workspace", "content_type": "inode/directory", "creation_time": "1640293213", "modification_time": "1640415770", "access_time": "1640293213" } ],
    "files": [  {"name": "renamed-test.txt", "content_type": "", "size": "363", "block_size": "1000000",  "creation_time": "1640415769", "modification_time": "1640415769", "access_time": "1640415771" } }
  */
  const self = this
  self.checkAuth(function (err) {
    if (err) {
      felog('error checking ')
      callback(err)
    } else {
      const cookieOpts = { headers: { Cookie: self.cookie.text } }
      https.get('https://' + self.credentials.fdsGateway + '/v1/dir/ls?pod_name=' + self.credentials.podname + '&dir_path=/' + dirpath, cookieOpts, (res) => {
        res.on('data', (returns) => {
          if (returns) {
            returns = returns.toString()
            returns = JSON.parse(returns)
            var files = []
            if (returns.dirs && returns.dirs.length > 0) {
              returns.dirs.forEach(item => { files.push(item.name) })
            }
            if (returns.files && returns.files.length > 0) {
              returns.files.forEach(item => { files.push(item.name) })
            }
          }
          if (returns.code === 404) {
            callback(new Error(FILE_DOES_NOT_EXIT))
          } else {
            fdlog('want to return files from readdir ', files)
            callback(null, files)
          }
        }).on('error', (e) => {
          console.error('fds readdir error', e)
          callback(e)
        })
      })
    }
  })
}
fdsFairOs.prototype.stat = function (path, callback) {
  const cookieOpts = { headers: { Cookie: this.cookie.text } }
  const self = this
  this.checkAuth(function (err) {
    if (err) {
      felog('error checking auth for stat ', err)
      callback(err)
    } else {
      https.get('https://' + self.credentials.fdsGateway + '/v1/file/stat?pod_name=' + self.credentials.podname + '&file_path=/' + path, cookieOpts, (res) => {
        res.on('data', (returns) => {
          if (returns) returns = returns.toString()
          returns = JSON.parse(returns)
          fdlog('stat ', { returns })
          if (returns.code === 400) {
            callback(new Error(returns.message))
          } else if (returns.code === 500) {
            if (returns.message.indexOf('file not found') < 0) {
              callback(new Error('SNBH - file stats error 500 should only be file nt found'))
            } else {
              https.get('https://' + self.credentials.fdsGateway + '/v1/dir/stat?pod_name=' + self.credentials.podname + '&dir_path=/' + path, cookieOpts, (res) => {
                res.on('data', (returns) => {
                  if (returns) returns = returns.toString()
                  returns = JSON.parse(returns)
                  fdlog('stat for folder', { returns })
                  if (returns.code === 400) {
                    callback(new Error(returns.message))
                  } else if (returns.code === 500) {
                    if (returns.message.indexOf('file not found') < 0) {
                      callback(new Error('SNBH - file stats error 500 should only be file nt found'))
                    } else {
                      callback(new Error('no such file or directory ' + path))
                    }
                  } else {
                    returns.type = 'dir'
                    returns.atimeMs = Number(returns.access_time) * 1000
                    returns.mtimeMs = Number(returns.modification_time) * 1000
                    returns.birthtimeMs = Number(returns.creation_time) * 1000
                    callback(null, returns)
                  }
                }).on('error', (e) => {
                  console.error(e)
                  callback(e)
                })
              })
            }
          } else {
            returns.type = 'file'
            returns.size = returns.filesize
            returns.atimeMs = Number(returns.access_time) * 1000
            returns.mtimeMs = Number(returns.modification_time) * 1000
            returns.birthtimeMs = Number(returns.creation_time) * 1000

            callback(null, returns)
          }
        }).on('error', (e) => {
          console.error(e)
          callback(e)
        })
      })
    }
  })
}

// Other file system...
fdsFairOs.prototype.getFileToSend = function (path, callback) {
  const self = this

  this.checkAuth(function (err) {
    if (err) {
      felog('error checking auth in getFileToSend ', err)
      callback(err)
    } else {
      const getFileOptions = {
        hostname: self.credentials.fdsGateway,
        path: '/v1/file/download?pod_name=' + self.credentials.podname + '&file_path=/' + path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', // 'application/x-www-form-urlencoded', //
          // 'Content-Length': ''.length,
          Cookie: self.cookie.text
        }
      }
      var fullfile = ''
      const getFileReq = https.request(getFileOptions, (getFileResp) => {
        getFileResp.on('end', function () {
          fdlog('ended here fullfile', fullfile)
          callback(null, fullfile)
        })
        getFileResp.on('data', (getFileReturns) => {
          fullfile += getFileReturns.toString()
        })
      })
      getFileReq.on('error', (error) => {
        felog('error in getting file ', error)
        callback(error)
      })
      getFileReq.write('')
      getFileReq.end()
    }
  })
}
fdsFairOs.prototype.removeFolder = function (dirpath, callback) {
  fdlog(' - fds -removeFolder ', dirpath)
  fdlog(' - fds -removeFolder is func ', (callback instanceof Function))
  const self = this
  self.readdir(dirpath, null, function (err, files) {
    if (err) {
      callback(err)
    } else if (files && files.length > 0) {
      async.forEach(files, function (file, cb) {
        file = dirpath + '/' + file
        self.stat(file, function (err, stat) {
          if (err) {
            return cb(err)
          } else if (stat.type === 'dir') {
            self.removeFolder(file, cb)
          } else {
            self.unlink(file, function (err) {
              if (err) {
                return cb(err)
              } else {
                return cb()
              }
            })
          }
        })
      }, function (err) {
        if (err) {
          return callback(err)
        } else {
          self.removeEmptyFolder(dirpath, callback)
        }
      })
    } else {
      fdlog(' - fds -going to empty folder ', (callback instanceof Function))
      self.removeEmptyFolder(dirpath, callback)
    }
  })
}
fdsFairOs.prototype.removeEmptyFolder = function (dirpath, callback) {
  fdlog(' - fds -removeEmptyFolder ', dirpath)
  const self = this
  self.checkAuth(function (err) {
    if (err) {
      felog('error checking auth for removeEmptyFolder ', err)
      callback(err)
    } else {
      const rmdirParams = {
        pod_name: self.credentials.podname,
        dir_path: ('/' + dirpath)
      }
      const rmdirOptions = {
        hostname: self.credentials.fdsGateway,
        path: '/v1/dir/rmdir',
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': JSON.stringify(rmdirParams).length,
          Cookie: self.cookie.text
        }
      }
      const rmdirReq = https.request(rmdirOptions, (rmdirResp) => {
        rmdirResp.on('data', (rmdirReturns) => {
          if (rmdirReturns) rmdirReturns = rmdirReturns.toString()
          rmdirReturns = JSON.parse(rmdirReturns)

          if (!rmdirReturns || rmdirReturns.code !== 200) {
            self.folderExists(dirpath, (err, res) => {
              if (!err && res && res.present === false) {
                callback(null)
              } else {
                if (err) felog('err in seeing if removable folder exists ', err)
                if (res && res.present) felog('err and res.present ', res)
                felog('error in rmdir ing  ', { rmdirReturns })
                callback(err)
              }
            })
          } else {
            fdlog('folder deleted' + dirpath)
            const localFilePath = self.credentials.tempLocalFolder + '/' + dirpath
            if (fs.existsSync(localFilePath)) fs.rmdirSync(localFilePath)
            callback(null)
          }
        })
      })
      rmdirReq.on('error', (error) => {
        felog('error in deleting folder ', error)
        callback(error)
      })
      rmdirReq.write(JSON.stringify(rmdirParams))
      rmdirReq.end()
    }
  })
}
/*

const self = this
async.waterfall([
  function (cb) {
    // check exists
  },
  function (cb) {
    // get file
  },
  function (cb) {
  },
  function (cb) {
  }
], function (err) {

})
*/

// nedb-specific
fdsFairOs.prototype.appendNedbTableFile = function (path, contents, encoding, callback) {
  // The main different with the standard functions from local fs, is that instead of appending to the
  // main file which requires a full read and write operation every time,
  // appended items are added to another folder - one file per record - and then read back when the
  // (table) file is read, or deleted after crashSafeWriteNedbFile

  fdlog(' - fds-appendNedbTableFile start ', path, contents) // new Date().toLocaleTimeString() + ' : ' + new Date().getMilliseconds()
  // if (encoding) console.warn('ignoring encoding on append for file ',path)

  const [appendDirectory] = getnamesForAppendFilesFrom(path)
  path = appendDirectory + '/' + dateBasedNameForFile()

  this.writeFile(path, contents, { doNotOverWrite: true }, callback)
}
fdsFairOs.prototype.readNedbTableFile = function (path, encoding, callback) {
  // read file goes through folder with appends, and adds them to content
  fdlog(' - fds - readNedbTableFile ', path)
  const self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(path)
  let contents = ''

  self.readFile(path, {}, (err, mainfileContent) => {
    if (err && err.message !== FILE_DOES_NOT_EXIT) {
      felog('file read err message', err.message)
      callback(err)
    } else {
      if (!mainfileContent) mainfileContent = ''
      if (err && err.message === FILE_DOES_NOT_EXIT) {
        mainfileContent = ''
      } else if (typeof mainfileContent === 'object') {
        mainfileContent = JSON.stringify(mainfileContent) + '\n'
      } else if (typeof mainfileContent !== 'string') {
        mainfileContent = mainfileContent.toString()
        // if (mainfileContent.length>2 && mainfileContent.slice(contents.length-1) !== '\n') mainfileContent += '\n'
      }
      contents = mainfileContent

      var toSortEntries = []

      self.getAllAppendDirectoryFiles(appendDirectory, true, (err, results) => { // { folderId, entries }
        if (!err && results && results.length > 0) {
          async.forEach(results, (filename, cb) => {
            self.readFile(appendDirectory + '/' + filename, null, function (err, fileContent) {
              if (err) {
                cb(err)
              } else {
                toSortEntries.push({ name: filename, data: fileContent })
                cb(null)
              }
            })
          }, (err) => {
            if (err) {
              felog('Err in getting nedb file content', err)
              callback(err)
            } else {
              toSortEntries = toSortEntries.sort(sortObjectByNameMod)
              // download contents and add
              for (var i = 0; i < toSortEntries.length; i++) {
                contents += toSortEntries[i].data
              }
              fdlog('e1 DB populated with:' + contents + '.END')
              callback(null, contents)
            }
          })
        } else if (err) {
          callback(err)
        } else {
          if (contents && contents.length > 1 && contents.slice(contents.length - 2) === '\n\n') contents = contents.slice(0, contents.length - 1)
          fdlog('e2 DB populated with:' + contents + '.END')
          callback(err, contents)
        }
      })
    }
  })
}
fdsFairOs.prototype.writeNedbTableFile = function (filename, data, options, callback) {
  // new writeFile also writes over the appended file directory
  fdlog(' - fds - writeNedbTableFile ', { filename, data }) // data

  const self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(filename)
  const now = new Date().getTime()

  self.writeFile(filename, data, {}, function (err) {
    if (err) {
      felog('writeNedbTableFile', 'error writing file in writeNedbTableFile', err)
      return callback(err)
    } else {
      self.getAllAppendDirectoryFiles(appendDirectory, true, (err, results) => { // { folderId, entries }
        if (!err && results && results && results.length > 0) {
          results = results.sort(dateFromNameSort)
          async.forEach(results, (filename, cb) => {
            if (timeFromPath(filename) < now) {
              self.unlink(appendDirectory + '/' + filename, function (err) {
                cb(err)
              })
            } else {
              cb(null)
            }
          }, (err) => {
            if (err) felog('Err in deleting nedb appendDirectory files ', err)
            callback(err)
          })
        } else {
          callback(err)
        }
      })
    }
  })
}
fdsFairOs.prototype.deleteNedbTableFiles = function (file, callback) {
  fdlog('fds deleteNedbTableFiles ', file)
  const [appendDirectory] = getnamesForAppendFilesFrom(file)
  const self = this

  self.unlink(file, function (err) {
    if (err) {
      if (err.message === FILE_DOES_NOT_EXIT) {
        callback(null)
      } else {
        felog('err in deleteNedbTableFiles - todo: if filenotfound then ignore for file ' + file, err)
        return callback(err)
      }
    } else {
      self.removeFolder(appendDirectory, function (err) {
        if (err) felog('err in deleteNedbTableFiles - todo: if filenotfound then ignore for file ' + file, err)
        return callback(err)
      })
    }
  })
}
fdsFairOs.prototype.crashSafeWriteNedbFile = function (filename, data, callback) {
  // For storage services, the crashSafeWriteNedbFile is really crashSafeWriteFileOnlyIfThereAreApppendedRecordFiles
  // if there are no appended records (which are stored in files (See appendNedbTableFile above) ) then there is no need to rewrite the file

  // NOTE: THIS SHOULD ONLY BE CALLED WHEN THE INMEMORY DB ACTUALLY HAS ALL THE DATA - IE THAT IT HAS PERSISTED

  // If the temporary directory exists, then new items have been added, so we know we have to save

  const self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(filename)
  const now = new Date().getTime()

  fdlog('fds crashSafeWriteNedbFile write ', { filename }) // data

  async.waterfall([
    // Write the new file and then delete the temp folder
    function (cb) {
      return self.unlink(tempOf(filename), cb)
    },
    function (cb) {
      self.writeFile(tempOf(filename), data, {}, function (err) { return cb(err) })
    },
    function (cb) {
      return self.unlink(filename, cb)
    },
    function (cb) {
      self.rename(tempOf(filename), filename, function (err) {
        return cb(err)
      })
    },
    function (cb) {
      self.getAllAppendDirectoryFiles(appendDirectory, true, cb)
    },
    function (results, cb) {
      if (results && results.length > 0) {
        results = results.sort(dateFromNameSort)
        async.forEach(results, (filename, cb2) => {
          if (timeFromPath(filename) < now) {
            self.unlink(appendDirectory + '/' + filename, function (err) {
              cb2(err)
            })
          } else {
            cb2(null)
          }
        }, (err) => {
          if (err) felog('Err in deleting nedb appendDirectory files ', err)
          cb(err)
        })
      } else {
        cb(null)
      }
    }
  ],
  function (err) {
    if (err) felog('end of crashSafeWriteNedbFile write', { err, data })
    return callback(err)
  })
}

// fds helper functions
const FILE_DOES_NOT_EXIT = 'download: file not present'
fdsFairOs.prototype.getAllAppendDirectoryFiles = function (appendDirectory, ignoreTime, callback) {
  const self = this
  self.getOrMakeFolders(appendDirectory, { doNotMake: false }, function (err, folderDetails) {
    if (err) {
      callback(err)
    } else {
      self.readdir(appendDirectory, {}, function (err, dirs) {
        if (err) {
          callback(err)
        } else if (!dirs) {
          callback(err)
        } else if (dirs.length === 0) {
          callback(null, dirs)
        } else {
          dirs = dirs.sort(dateFromNameSort)
          callback(null, dirs)
        }
      })
    }
  })
}

const appendFileFolderName = function (filename) {
  var parts = filename.split('.')
  parts.pop()
  return '~' + filename
}
const getnamesForAppendFilesFrom = function (path) {
  const parts = path.split('/')
  const originalDbFilename = parts.pop()
  const appendDirectoryName = appendFileFolderName(originalDbFilename)
  parts.push(appendDirectoryName)
  path = parts.join('/')
  return [path, originalDbFilename, appendDirectoryName]
}

fdsFairOs.prototype.getOrMakeFolders = function (path, options, callback) {
  // options doNotMake: doesnot make a folder if it doesnt exist
  fdlog(' - fds-getOrMakeFolders ', path)

  const self = this

  this.checkAuth(function (err) {
    if (err) {
      felog('error checking auth for getOrMakeFolders')
      callback(err)
    } else {
      var pathParts = path.split('/')
      let currentFolderName = ''
      options = options || {}

      async.whilst(
        function test (cb) {
          cb(null, pathParts.length > 0)
        },
        function (cb) {
          currentFolderName += ('/' + pathParts.shift())
          // try creating if exists then ok
          self.folderExists(currentFolderName, function (err, returns) {
            // if (returns) returns = JSON.parse(returns.toString())
            fdlog({ returns })
            if (err) {
              cb(err)
            } else if (returns.present) {
              fdlog('dir exists ' + currentFolderName)
              cb(null)
            } else if (options.doNotMake) {
              cb(new Error('doNotMake is turned on - dir doent exist for ' + currentFolderName))
            } else {
              const makeParams = {
                pod_name: self.credentials.podname,
                dir_path: currentFolderName
              }
              const makeOptions = {
                hostname: self.credentials.fdsGateway,
                path: '/v1/dir/mkdir',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': JSON.stringify(makeParams).length,
                  Cookie: self.cookie.text
                }
              }
              const dirMakeReq = https.request(makeOptions, (makeDirResp) => {
                makeDirResp.on('data', (makeDirReturns) => {
                  if (makeDirReturns) makeDirReturns = makeDirReturns.toString()
                  fdlog('returns from makeDir ', makeDirReturns)
                  makeDirReturns = JSON.parse(makeDirReturns)

                  if (!makeDirReturns || makeDirReturns.code !== 201) {
                    felog('error in make dir ', { makeDirReturns })
                    cb(new Error('fds mkdir: ' + makeDirReturns.message))
                  } else {
                    fdlog('dir created ' + currentFolderName)
                    cb(null)
                  }
                })
              })
              dirMakeReq.on('error', (error) => {
                felog('error in making dir ', error)
                cb(error)
              })
              dirMakeReq.write(JSON.stringify(makeParams))
              dirMakeReq.end()
            }
          })
        },
        function (err) {
          if (err) {
            felog('fds error in making recursive directory for ' + path, err)
            callback(err)
          } else {
            callback(null)
          }
        }
      )
    }
  })
}
fdsFairOs.prototype.exists = function (fileOrFolder, callback) {
  fdlog('exists ', fileOrFolder)
  const self = this
  self.fileExists(fileOrFolder, function (err, returns) {
    fdlog('file exists ? ', { returns })
    if (err || !returns.present) {
      self.folderExists(fileOrFolder, function (err, returns) {
        if (err || !returns.present) {
          callback(false)
        } else {
          callback(true)
        }
      })
    } else {
      callback(true)
    }
  })
}
fdsFairOs.prototype.isPresent = function (fileOrFolder, callback) {
  fdlog('isPresent ', fileOrFolder)
  const self = this
  self.fileExists(fileOrFolder, function (err, returns) {
    fdlog('file exists ? ', { returns })
    if (err || !returns.present) {
      self.folderExists(fileOrFolder, function (err, returns) {
        if (err || !returns) {
          felog('isPresent e ', { err, returns })
          callback((err || new Error('unknown error')))
        } else {
          callback(null, returns.present)
        }
      })
    } else {
      callback(null, true)
    }
  })
}
fdsFairOs.prototype.folderExists = function (path, callback) {
  // assume path starts with '/'
  const self = this
  fdlog('fds -folderExists ')
  self.checkAuth(function (err, ret) {
    if (err) {
      felog('error checking auth for folderExists', err)
      callback(err)
    } else {
      const cookieOpts = { headers: { Cookie: self.cookie.text } }
      https.get('https://' + self.credentials.fdsGateway + '/v1/dir/present?pod_name=' + self.credentials.podname + '&dir_path=' + path, cookieOpts, (res) => {
        res.on('data', (returns) => {
          if (returns) {
            returns = returns.toString()
            returns = JSON.parse(returns)
          }
          fdlog('folderExists ', { returns })
          callback(null, returns)
        }).on('error', (e) => {
          console.error('fds folderExists error', e)
          callback(e)
        })
      })
    }
  })
}
fdsFairOs.prototype.fileExists = function (path, callback) {
  // assumed path does NOT start with '/'
  const cookieOpts = { headers: { Cookie: this.cookie.text } }
  const self = this
  this.checkAuth(function (err) {
    if (err) {
      felog('error checking auth for fileExists ', err)
      callback(err)
    } else {
      https.get('https://' + self.credentials.fdsGateway + '/v1/file/stat?pod_name=' + self.credentials.podname + '&file_path=/' + path, cookieOpts, (res) => {
        res.on('data', (returns) => {
          if (returns) returns = returns.toString()
          returns = JSON.parse(returns)
          fdlog('fileExists ', { returns })
          if (returns.code === 400) {
            callback(new Error(returns.message))
          } else if (returns.code === 500) {
            if (returns.message.indexOf('file not found') < 0) {
              callback(new Error('SNBH - file stats error 500 should only be file nt found'))
            } else {
              callback(null, { present: false })
            }
          } else {
            callback(null, { present: true, details: returns })
          }
        }).on('error', (e) => {
          felog(e)
          callback(e)
        })
      })
    }
  })
}
fdsFairOs.prototype.checkAuth = function (callback) {
  // CHECKS COOKIE - IF exiats and not expired, stays
  // If not, tries to login and store new cookie
  // then tries to pen pod - or if pod doesnt exist, it
  fdlog('fdsFairOs  - checkAuth ', this.credentials)
  if (!this.credentials || !this.credentials.userName || !this.credentials.fdsPass ||
    !this.credentials.podname || !this.credentials.tempLocalFolder || !this.credentials.fdsGateway) {
    callback(new Error('Missing credentials for fds auth check'))
  } else if (!this.cookie || !this.cookie.text || expiredCookie(this.cookie)) {
    const params = {
      user_name: this.credentials.userName,
      password: this.credentials.fdsPass,
      pod_name: this.credentials.podname
    }
    const fdsThis = this

    const sendOptions = {
      hostname: fdsThis.credentials.fdsGateway,
      path: '/v1/user/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': JSON.stringify(params).length
      }
    }
    const authReq = https.request(sendOptions, (authResp) => {
      fdlog(authResp.headers)
      const theCookie = (authResp.headers && authResp.headers['set-cookie'] && authResp.headers['set-cookie'].length > 0) ? authResp.headers['set-cookie'][0] : null

      if (!theCookie) {
        fdsThis.cookie = {}
        felog('error in retrieving cookie ')
        callback(new Error('Failed login - Could not retrieve cookie on log in '))
      } else {
        fdsThis.cookie = { text: theCookie }
        var parts = theCookie.split(';')
        parts.forEach(item => {
          item = item.trim()
          if (item.substr(0, 7) === 'Expires') {
            const theDate = item.substr(8)
            fdsThis.cookie.expires = new Date(theDate).getTime()
          }
        })
        authResp.on('data', (returns) => {
          if (returns) returns = returns.toString()
          returns = JSON.parse(returns)
          fdlog({ returns })

          if (!returns || returns.code !== 200) {
            fdsThis.cookie = {}
            felog('error in returns ', { returns, theCookie })
            callback(new Error('fds login: ' + returns.message))
          } else {
            const podParams = {
              pod_name: fdsThis.credentials.podname,
              password: fdsThis.credentials.fdsPass
            }
            const podOptions = {
              hostname: fdsThis.credentials.fdsGateway,
              path: '/v1/pod/open',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': JSON.stringify(podParams).length,
                Cookie: fdsThis.cookie.text
              }
            }

            const podReq = https.request(podOptions, (podResp) => {
              podResp.on('data', (podReturns) => {
                if (podReturns) podReturns = podReturns.toString()
                fdlog('returns from pod 1 ', podReturns)
                podReturns = JSON.parse(podReturns)

                if (podReturns && podReturns.code >= 400 && podReturns.code < 500) { // pod does not exist
                  if (podReturns.message !== 'pod open: invalid pod name' && podReturns.message !== 'pod open: pod does not exist') {
                    console.warn('ERROR - MESSAGE Received from FDS Pod was not what was expected ', { podReturns })
                    felog('ERROR - MESSAGE Received from FDS Pod was not what was expected ', { podReturns })
                  }
                  const podCreateOptions = {
                    hostname: fdsThis.credentials.fdsGateway,
                    path: '/v1/pod/new',
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Content-Length': JSON.stringify(podParams).length,
                      Cookie: fdsThis.cookie.text
                    }
                  }
                  const podCreateReq = https.request(podCreateOptions, (podCreateResp) => {
                    podCreateResp.on('data', (podCreateReturns) => {
                      if (podCreateReturns) podCreateReturns = podCreateReturns.toString()
                      podCreateReturns = JSON.parse(podCreateReturns)
                      if (!podCreateReturns || podCreateReturns.code !== 201) {
                        felog('error in podCreateReturns ', { podCreateReturns })
                        callback(new Error('fds pod create - ' + podCreateReturns.message))
                      } else {
                        fdlog('Created Pod successfully')
                        callback(null)
                      }
                    })
                  })
                  podCreateReq.on('error', (error) => {
                    felog('error in pod opening ', error)
                    callback(error)
                  })
                  podCreateReq.write(JSON.stringify(podParams))
                  podCreateReq.end()
                } else if (!podReturns || podReturns.code !== 200) {
                  felog('error in returns ', { podReturns })
                  callback(new Error('fds pod open: ' + podReturns.message))
                } else {
                  fdlog('existing pod used', { fdsThis })
                  callback(null)
                }
              })
            })
            podReq.on('error', (error) => {
              felog('error in pod opening ', error)
              callback(error)
            })
            podReq.write(JSON.stringify(podParams))
            podReq.end()
          }
        })
      }
    })
    authReq.on('error', (error) => {
      felog('fds - error in transmit of login ', error)
      callback(error)
    })
    authReq.write(JSON.stringify(params))
    authReq.end()
  } else { // has cookie and is not expired
    callback(null)
  }
}
const expiredCookie = function (cookie) {
  if (!cookie || !cookie.expires) return true
  return (new Date().getTime() > cookie.expires)
}

// file conventions
const dateBasedNameForFile = function () {
  return 'rec-' + Math.round(Math.random() * 1000, 0) + '-' + new Date().getTime() + '.adb'
}
const timeFromPath = function (path) {
  let nameTime = path.slice(path.lastIndexOf('/') + 1)
  nameTime = nameTime.slice(nameTime.lastIndexOf('-') + 1, nameTime.lastIndexOf('.adb'))
  return Number(nameTime)
}
const dateFromNameSort = function (a, b) {
  if (!b || !a) {
    throw new Error('data mising in trying to sort ', a, b)
  } else {
    return timeFromPath(a) - timeFromPath(b)
  }
}
function sortObjectByNameMod (a, b) {
  if (!b || !b.name || !a || !a.name) {
    throw new Error('data mising in trying to sort ', a, b)
  } else {
    return timeFromPath(a.name) - timeFromPath(b.name)
  }
}
const tempOf = function (filename) {
  return filename + '~'
}

const makeMnemonic = function () {
  const MNEMONIC_CHOICES = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual', 'adapt', 'add', 'addict', 'address', 'adjust', 'admit', 'adult', 'advance', 'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'age', 'agent', 'agree', 'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm', 'album', 'alcohol', 'alert', 'alien', 'all', 'alley', 'allow', 'almost', 'alone', 'alpha', 'already', 'also', 'alter', 'always', 'amateur', 'amazing', 'among', 'amount', 'amused', 'analyst', 'anchor', 'ancient', 'anger', 'angle', 'angry', 'animal', 'ankle', 'announce', 'annual', 'another', 'answer', 'antenna', 'antique', 'anxiety', 'any', 'apart', 'apology', 'appear', 'apple', 'approve', 'april', 'arch', 'arctic', 'area', 'arena', 'argue', 'arm', 'armed', 'armor', 'army', 'around', 'arrange', 'arrest', 'arrive', 'arrow', 'art', 'artefact', 'artist', 'artwork', 'ask', 'aspect', 'assault', 'asset', 'assist', 'assume', 'asthma', 'athlete', 'atom', 'attack', 'attend', 'attitude', 'attract', 'auction', 'audit', 'august', 'aunt', 'author', 'auto', 'autumn', 'average', 'avocado', 'avoid', 'awake', 'aware', 'away', 'awesome', 'awful', 'awkward', 'axis', 'baby', 'bachelor', 'bacon', 'badge', 'bag', 'balance', 'balcony', 'ball', 'bamboo', 'banana', 'banner', 'bar', 'barely', 'bargain', 'barrel', 'base', 'basic', 'basket', 'battle', 'beach', 'bean', 'beauty', 'because', 'become', 'beef', 'before', 'begin', 'behave', 'behind', 'believe', 'below', 'belt', 'bench', 'benefit', 'best', 'betray', 'better', 'between', 'beyond', 'bicycle', 'bid', 'bike', 'bind', 'biology', 'bird', 'birth', 'bitter', 'black', 'blade', 'blame', 'blanket', 'blast', 'bleak', 'bless', 'blind', 'blood', 'blossom', 'blouse', 'blue', 'blur', 'blush', 'board', 'boat', 'body', 'boil', 'bomb', 'bone', 'bonus', 'book', 'boost', 'border', 'boring', 'borrow', 'boss', 'bottom', 'bounce', 'box', 'boy', 'bracket', 'brain', 'brand', 'brass', 'brave', 'bread', 'breeze', 'brick', 'bridge', 'brief', 'bright', 'bring', 'brisk', 'broccoli', 'broken', 'bronze', 'broom', 'brother', 'brown', 'brush', 'bubble', 'buddy', 'budget', 'buffalo', 'build', 'bulb', 'bulk', 'bullet', 'bundle', 'bunker', 'burden', 'burger', 'burst', 'bus', 'business', 'busy', 'butter', 'buyer', 'buzz', 'cabbage', 'cabin', 'cable', 'cactus', 'cage', 'cake', 'call', 'calm', 'camera', 'camp', 'can', 'canal', 'cancel', 'candy', 'cannon', 'canoe', 'canvas', 'canyon', 'capable', 'capital', 'captain', 'car', 'carbon', 'card', 'cargo', 'carpet', 'carry', 'cart', 'case', 'cash', 'casino', 'castle', 'casual', 'cat', 'catalog', 'catch', 'category', 'cattle', 'caught', 'cause', 'caution', 'cave', 'ceiling', 'celery', 'cement', 'census', 'century', 'cereal', 'certain', 'chair', 'chalk', 'champion', 'change', 'chaos', 'chapter', 'charge', 'chase', 'chat', 'cheap', 'check', 'cheese', 'chef', 'cherry', 'chest', 'chicken', 'chief', 'child', 'chimney', 'choice', 'choose', 'chronic', 'chuckle', 'chunk', 'churn', 'cigar', 'cinnamon', 'circle', 'citizen', 'city', 'civil', 'claim', 'clap', 'clarify', 'claw', 'clay', 'clean', 'clerk', 'clever', 'click', 'client', 'cliff', 'climb', 'clinic', 'clip', 'clock', 'clog', 'close', 'cloth', 'cloud', 'clown', 'club', 'clump', 'cluster', 'clutch', 'coach', 'coast', 'coconut', 'code', 'coffee', 'coil', 'coin', 'collect', 'color', 'column', 'combine', 'come', 'comfort', 'comic', 'common', 'company', 'concert', 'conduct', 'confirm', 'congress', 'connect', 'consider', 'control', 'convince', 'cook', 'cool', 'copper', 'copy', 'coral', 'core', 'corn', 'correct', 'cost', 'cotton', 'couch', 'country', 'couple', 'course', 'cousin', 'cover', 'coyote', 'crack', 'cradle', 'craft', 'cram', 'crane', 'crash', 'crater', 'crawl', 'crazy', 'cream', 'credit', 'creek', 'crew', 'cricket', 'crime', 'crisp', 'critic', 'crop', 'cross', 'crouch', 'crowd', 'crucial', 'cruel', 'cruise', 'crumble', 'crunch', 'crush', 'cry', 'crystal', 'cube', 'culture', 'cup', 'cupboard', 'curious', 'current', 'curtain', 'curve', 'cushion', 'custom', 'cute', 'cycle', 'dad', 'damage', 'damp', 'dance', 'danger', 'daring', 'dash', 'daughter', 'dawn', 'day', 'deal', 'debate', 'debris', 'decade', 'december', 'decide', 'decline', 'decorate', 'decrease', 'deer', 'defense', 'define', 'defy', 'degree', 'delay', 'deliver', 'demand', 'demise', 'denial', 'dentist', 'deny', 'depart', 'depend', 'deposit', 'depth', 'deputy', 'derive', 'describe', 'desert', 'design', 'desk', 'despair', 'destroy', 'detail', 'detect', 'develop', 'device', 'devote', 'diagram', 'dial', 'diamond', 'diary', 'dice', 'diesel', 'diet', 'differ', 'digital', 'dignity', 'dilemma', 'dinner', 'dinosaur', 'direct', 'dirt', 'disagree', 'discover', 'disease', 'dish', 'dismiss', 'disorder', 'display', 'distance', 'divert', 'divide', 'divorce', 'dizzy', 'doctor', 'document', 'dog', 'doll', 'dolphin', 'domain', 'donate', 'donkey', 'donor', 'door', 'dose', 'double', 'dove', 'draft', 'dragon', 'drama', 'drastic', 'draw', 'dream', 'dress', 'drift', 'drill', 'drink', 'drip', 'drive', 'drop', 'drum', 'dry', 'duck', 'dumb', 'dune', 'during', 'dust', 'dutch', 'duty', 'dwarf', 'dynamic', 'eager', 'eagle', 'early', 'earn', 'earth', 'easily', 'east', 'easy', 'echo', 'ecology', 'economy', 'edge', 'edit', 'educate', 'effort', 'egg', 'eight', 'either', 'elbow', 'elder', 'electric', 'elegant', 'element', 'elephant', 'elevator', 'elite', 'else', 'embark', 'embody', 'embrace', 'emerge', 'emotion', 'employ', 'empower', 'empty', 'enable', 'enact', 'end', 'endless', 'endorse', 'enemy', 'energy', 'enforce', 'engage', 'engine', 'enhance', 'enjoy', 'enlist', 'enough', 'enrich', 'enroll', 'ensure', 'enter', 'entire', 'entry', 'envelope', 'episode', 'equal', 'equip', 'era', 'erase', 'erode', 'erosion', 'error', 'erupt', 'escape', 'essay', 'essence', 'estate', 'eternal', 'ethics', 'evidence', 'evil', 'evoke', 'evolve', 'exact', 'example', 'excess', 'exchange', 'excite', 'exclude', 'excuse', 'execute', 'exercise', 'exhaust', 'exhibit', 'exile', 'exist', 'exit', 'exotic', 'expand', 'expect', 'expire', 'explain', 'expose', 'express', 'extend', 'extra', 'eye', 'eyebrow', 'fabric', 'face', 'faculty', 'fade', 'faint', 'faith', 'fall', 'FALSE', 'fame', 'family', 'famous', 'fan', 'fancy', 'fantasy', 'farm', 'fashion', 'fat', 'fatal', 'father', 'fatigue', 'fault', 'favorite', 'feature', 'february', 'federal', 'fee', 'feed', 'feel', 'female', 'fence', 'festival', 'fetch', 'fever', 'few', 'fiber', 'fiction', 'field', 'figure', 'file', 'film', 'filter', 'final', 'find', 'fine', 'finger', 'finish', 'fire', 'firm', 'first', 'fiscal', 'fish', 'fit', 'fitness', 'fix', 'flag', 'flame', 'flash', 'flat', 'flavor', 'flee', 'flight', 'flip', 'float', 'flock', 'floor', 'flower', 'fluid', 'flush', 'fly', 'foam', 'focus', 'fog', 'foil', 'fold', 'follow', 'food', 'foot', 'force', 'forest', 'forget', 'fork', 'fortune', 'forum', 'forward', 'fossil', 'foster', 'found', 'fox', 'fragile', 'frame', 'frequent', 'fresh', 'friend', 'fringe', 'frog', 'front', 'frost', 'frown', 'frozen', 'fruit', 'fuel', 'fun', 'funny', 'furnace', 'fury', 'future', 'gadget', 'gain', 'galaxy', 'gallery', 'game', 'gap', 'garage', 'garbage', 'garden', 'garlic', 'garment', 'gas', 'gasp', 'gate', 'gather', 'gauge', 'gaze', 'general', 'genius', 'genre', 'gentle', 'genuine', 'gesture', 'ghost', 'giant', 'gift', 'giggle', 'ginger', 'giraffe', 'girl', 'give', 'glad', 'glance', 'glare', 'glass', 'glide', 'glimpse', 'globe', 'gloom', 'glory', 'glove', 'glow', 'glue', 'goat', 'goddess', 'gold', 'good', 'goose', 'gorilla', 'gospel', 'gossip', 'govern', 'gown', 'grab', 'grace', 'grain', 'grant', 'grape', 'grass', 'gravity', 'great', 'green', 'grid', 'grief', 'grit', 'grocery', 'group', 'grow', 'grunt', 'guard', 'guess', 'guide', 'guilt', 'guitar', 'gun', 'gym', 'habit', 'hair', 'half', 'hammer', 'hamster', 'hand', 'happy', 'harbor', 'hard', 'harsh', 'harvest', 'hat', 'have', 'hawk', 'hazard', 'head', 'health', 'heart', 'heavy', 'hedgehog', 'height', 'hello', 'helmet', 'help', 'hen', 'hero', 'hidden', 'high', 'hill', 'hint', 'hip', 'hire', 'history', 'hobby', 'hockey', 'hold', 'hole', 'holiday', 'hollow', 'home', 'honey', 'hood', 'hope', 'horn', 'horror', 'horse', 'hospital', 'host', 'hotel', 'hour', 'hover', 'hub', 'huge', 'human', 'humble', 'humor', 'hundred', 'hungry', 'hunt', 'hurdle', 'hurry', 'hurt', 'husband', 'hybrid', 'ice', 'icon', 'idea', 'identify', 'idle', 'ignore', 'ill', 'illegal', 'illness', 'image', 'imitate', 'immense', 'immune', 'impact', 'impose', 'improve', 'impulse', 'inch', 'include', 'income', 'increase', 'index', 'indicate', 'indoor', 'industry', 'infant', 'inflict', 'inform', 'inhale', 'inherit', 'initial', 'inject', 'injury', 'inmate', 'inner', 'innocent', 'input', 'inquiry', 'insane', 'insect', 'inside', 'inspire', 'install', 'intact', 'interest', 'into', 'invest', 'invite', 'involve', 'iron', 'island', 'isolate', 'issue', 'item', 'ivory', 'jacket', 'jaguar', 'jar', 'jazz', 'jealous', 'jeans', 'jelly', 'jewel', 'job', 'join', 'joke', 'journey', 'joy', 'judge', 'juice', 'jump', 'jungle', 'junior', 'junk', 'just', 'kangaroo', 'keen', 'keep', 'ketchup', 'key', 'kick', 'kid', 'kidney', 'kind', 'kingdom', 'kiss', 'kit', 'kitchen', 'kite', 'kitten', 'kiwi', 'knee', 'knife', 'knock', 'know', 'lab', 'label', 'labor', 'ladder', 'lady', 'lake', 'lamp', 'language', 'laptop', 'large', 'later', 'latin', 'laugh', 'laundry', 'lava', 'law', 'lawn', 'lawsuit', 'layer', 'lazy', 'leader', 'leaf', 'learn', 'leave', 'lecture', 'left', 'leg', 'legal', 'legend', 'leisure', 'lemon', 'lend', 'length', 'lens', 'leopard', 'lesson', 'letter', 'level', 'liar', 'liberty', 'library', 'license', 'life', 'lift', 'light', 'like', 'limb', 'limit', 'link', 'lion', 'liquid', 'list', 'little', 'live', 'lizard', 'load', 'loan', 'lobster', 'local', 'lock', 'logic', 'lonely', 'long', 'loop', 'lottery', 'loud', 'lounge', 'love', 'loyal', 'lucky', 'luggage', 'lumber', 'lunar', 'lunch', 'luxury', 'lyrics', 'machine', 'mad', 'magic', 'magnet', 'maid', 'mail', 'main', 'major', 'make', 'mammal', 'man', 'manage', 'mandate', 'mango', 'mansion', 'manual', 'maple', 'marble', 'march', 'margin', 'marine', 'market', 'marriage', 'mask', 'mass', 'master', 'match', 'material', 'math', 'matrix', 'matter', 'maximum', 'maze', 'meadow', 'mean', 'measure', 'meat', 'mechanic', 'medal', 'media', 'melody', 'melt', 'member', 'memory', 'mention', 'menu', 'mercy', 'merge', 'merit', 'merry', 'mesh', 'message', 'metal', 'method', 'middle', 'midnight', 'milk', 'million', 'mimic', 'mind', 'minimum', 'minor', 'minute', 'miracle', 'mirror', 'misery', 'miss', 'mistake', 'mix', 'mixed', 'mixture', 'mobile', 'model', 'modify', 'mom', 'moment', 'monitor', 'monkey', 'monster', 'month', 'moon', 'moral', 'more', 'morning', 'mosquito', 'mother', 'motion', 'motor', 'mountain', 'mouse', 'move', 'movie', 'much', 'muffin', 'mule', 'multiply', 'muscle', 'museum', 'mushroom', 'music', 'must', 'mutual', 'myself', 'mystery', 'myth', 'naive', 'name', 'napkin', 'narrow', 'nasty', 'nation', 'nature', 'near', 'neck', 'need', 'negative', 'neglect', 'neither', 'nephew', 'nerve', 'nest', 'net', 'network', 'neutral', 'never', 'news', 'next', 'nice', 'night', 'noble', 'noise', 'nominee', 'noodle', 'normal', 'north', 'nose', 'notable', 'note', 'nothing', 'notice', 'novel', 'now', 'nuclear', 'number', 'nurse', 'nut', 'oak', 'obey', 'object', 'oblige', 'obscure', 'observe', 'obtain', 'obvious', 'occur', 'ocean', 'october', 'odor', 'off', 'offer', 'office', 'often', 'oil', 'okay', 'old', 'olive', 'olympic', 'omit', 'once', 'one', 'onion', 'online', 'only', 'open', 'opera', 'opinion', 'oppose', 'option', 'orange', 'orbit', 'orchard', 'order', 'ordinary', 'organ', 'orient', 'original', 'orphan', 'ostrich', 'other', 'outdoor', 'outer', 'output', 'outside', 'oval', 'oven', 'over', 'own', 'owner', 'oxygen', 'oyster', 'ozone', 'pact', 'paddle', 'page', 'pair', 'palace', 'palm', 'panda', 'panel', 'panic', 'panther', 'paper', 'parade', 'parent', 'park', 'parrot', 'party', 'pass', 'patch', 'path', 'patient', 'patrol', 'pattern', 'pause', 'pave', 'payment', 'peace', 'peanut', 'pear', 'peasant', 'pelican', 'pen', 'penalty', 'pencil', 'people', 'pepper', 'perfect', 'permit', 'person', 'pet', 'phone', 'photo', 'phrase', 'physical', 'piano', 'picnic', 'picture', 'piece', 'pig', 'pigeon', 'pill', 'pilot', 'pink', 'pioneer', 'pipe', 'pistol', 'pitch', 'pizza', 'place', 'planet', 'plastic', 'plate', 'play', 'please', 'pledge', 'pluck', 'plug', 'plunge', 'poem', 'poet', 'point', 'polar', 'pole', 'police', 'pond', 'pony', 'pool', 'popular', 'portion', 'position', 'possible', 'post', 'potato', 'pottery', 'poverty', 'powder', 'power', 'practice', 'praise', 'predict', 'prefer', 'prepare', 'present', 'pretty', 'prevent', 'price', 'pride', 'primary', 'print', 'priority', 'prison', 'private', 'prize', 'problem', 'process', 'produce', 'profit', 'program', 'project', 'promote', 'proof', 'property', 'prosper', 'protect', 'proud', 'provide', 'public', 'pudding', 'pull', 'pulp', 'pulse', 'pumpkin', 'punch', 'pupil', 'puppy', 'purchase', 'purity', 'purpose', 'purse', 'push', 'put', 'puzzle', 'pyramid', 'quality', 'quantum', 'quarter', 'question', 'quick', 'quit', 'quiz', 'quote', 'rabbit', 'raccoon', 'race', 'rack', 'radar', 'radio', 'rail', 'rain', 'raise', 'rally', 'ramp', 'ranch', 'random', 'range', 'rapid', 'rare', 'rate', 'rather', 'raven', 'raw', 'razor', 'ready', 'real', 'reason', 'rebel', 'rebuild', 'recall', 'receive', 'recipe', 'record', 'recycle', 'reduce', 'reflect', 'reform', 'refuse', 'region', 'regret', 'regular', 'reject', 'relax', 'release', 'relief', 'rely', 'remain', 'remember', 'remind', 'remove', 'render', 'renew', 'rent', 'reopen', 'repair', 'repeat', 'replace', 'report', 'require', 'rescue', 'resemble', 'resist', 'resource', 'response', 'result', 'retire', 'retreat', 'return', 'reunion', 'reveal', 'review', 'reward', 'rhythm', 'rib', 'ribbon', 'rice', 'rich', 'ride', 'ridge', 'rifle', 'right', 'rigid', 'ring', 'riot', 'ripple', 'risk', 'ritual', 'rival', 'river', 'road', 'roast', 'robot', 'robust', 'rocket', 'romance', 'roof', 'rookie', 'room', 'rose', 'rotate', 'rough', 'round', 'route', 'royal', 'rubber', 'rude', 'rug', 'rule', 'run', 'runway', 'rural', 'sad', 'saddle', 'sadness', 'safe', 'sail', 'salad', 'salmon', 'salon', 'salt', 'salute', 'same', 'sample', 'sand', 'satisfy', 'satoshi', 'sauce', 'sausage', 'save', 'say', 'scale', 'scan', 'scare', 'scatter', 'scene', 'scheme', 'school', 'science', 'scissors', 'scorpion', 'scout', 'scrap', 'screen', 'script', 'scrub', 'sea', 'search', 'season', 'seat', 'second', 'secret', 'section', 'security', 'seed', 'seek', 'segment', 'select', 'sell', 'seminar', 'senior', 'sense', 'sentence', 'series', 'service', 'session', 'settle', 'setup', 'seven', 'shadow', 'shaft', 'shallow', 'share', 'shed', 'shell', 'sheriff', 'shield', 'shift', 'shine', 'ship', 'shiver', 'shock', 'shoe', 'shoot', 'shop', 'short', 'shoulder', 'shove', 'shrimp', 'shrug', 'shuffle', 'shy', 'sibling', 'sick', 'side', 'siege', 'sight', 'sign', 'silent', 'silk', 'silly', 'silver', 'similar', 'simple', 'since', 'sing', 'siren', 'sister', 'situate', 'six', 'size', 'skate', 'sketch', 'ski', 'skill', 'skin', 'skirt', 'skull', 'slab', 'slam', 'sleep', 'slender', 'slice', 'slide', 'slight', 'slim', 'slogan', 'slot', 'slow', 'slush', 'small', 'smart', 'smile', 'smoke', 'smooth', 'snack', 'snake', 'snap', 'sniff', 'snow', 'soap', 'soccer', 'social', 'sock', 'soda', 'soft', 'solar', 'soldier', 'solid', 'solution', 'solve', 'someone', 'song', 'soon', 'sorry', 'sort', 'soul', 'sound', 'soup', 'source', 'south', 'space', 'spare', 'spatial', 'spawn', 'speak', 'special', 'speed', 'spell', 'spend', 'sphere', 'spice', 'spider', 'spike', 'spin', 'spirit', 'split', 'spoil', 'sponsor', 'spoon', 'sport', 'spot', 'spray', 'spread', 'spring', 'spy', 'square', 'squeeze', 'squirrel', 'stable', 'stadium', 'staff', 'stage', 'stairs', 'stamp', 'stand', 'start', 'state', 'stay', 'steak', 'steel', 'stem', 'step', 'stereo', 'stick', 'still', 'sting', 'stock', 'stomach', 'stone', 'stool', 'story', 'stove', 'strategy', 'street', 'strike', 'strong', 'struggle', 'student', 'stuff', 'stumble', 'style', 'subject', 'submit', 'subway', 'success', 'such', 'sudden', 'suffer', 'sugar', 'suggest', 'suit', 'summer', 'sun', 'sunny', 'sunset', 'super', 'supply', 'supreme', 'sure', 'surface', 'surge', 'surprise', 'surround', 'survey', 'suspect', 'sustain', 'swallow', 'swamp', 'swap', 'swarm', 'swear', 'sweet', 'swift', 'swim', 'swing', 'switch', 'sword', 'symbol', 'symptom', 'syrup', 'system', 'table', 'tackle', 'tag', 'tail', 'talent', 'talk', 'tank', 'tape', 'target', 'task', 'taste', 'tattoo', 'taxi', 'teach', 'team', 'tell', 'ten', 'tenant', 'tennis', 'tent', 'term', 'test', 'text', 'thank', 'that', 'theme', 'then', 'theory', 'there', 'they', 'thing', 'this', 'thought', 'three', 'thrive', 'throw', 'thumb', 'thunder', 'ticket', 'tide', 'tiger', 'tilt', 'timber', 'time', 'tiny', 'tip', 'tired', 'tissue', 'title', 'toast', 'tobacco', 'today', 'toddler', 'toe', 'together', 'toilet', 'token', 'tomato', 'tomorrow', 'tone', 'tongue', 'tonight', 'tool', 'tooth', 'top', 'topic', 'topple', 'torch', 'tornado', 'tortoise', 'toss', 'total', 'tourist', 'toward', 'tower', 'town', 'toy', 'track', 'trade', 'traffic', 'tragic', 'train', 'transfer', 'trap', 'trash', 'travel', 'tray', 'treat', 'tree', 'trend', 'trial', 'tribe', 'trick', 'trigger', 'trim', 'trip', 'trophy', 'trouble', 'truck', 'TRUE', 'truly', 'trumpet', 'trust', 'truth', 'try', 'tube', 'tuition', 'tumble', 'tuna', 'tunnel', 'turkey', 'turn', 'turtle', 'twelve', 'twenty', 'twice', 'twin', 'twist', 'two', 'type', 'typical', 'ugly', 'umbrella', 'unable', 'unaware', 'uncle', 'uncover', 'under', 'undo', 'unfair', 'unfold', 'unhappy', 'uniform', 'unique', 'unit', 'universe', 'unknown', 'unlock', 'until', 'unusual', 'unveil', 'update', 'upgrade', 'uphold', 'upon', 'upper', 'upset', 'urban', 'urge', 'usage', 'use', 'used', 'useful', 'useless', 'usual', 'utility', 'vacant', 'vacuum', 'vague', 'valid', 'valley', 'valve', 'van', 'vanish', 'vapor', 'various', 'vast', 'vault', 'vehicle', 'velvet', 'vendor', 'venture', 'venue', 'verb', 'verify', 'version', 'very', 'vessel', 'veteran', 'viable', 'vibrant', 'vicious', 'victory', 'video', 'view', 'village', 'vintage', 'violin', 'virtual', 'virus', 'visa', 'visit', 'visual', 'vital', 'vivid', 'vocal', 'voice', 'void', 'volcano', 'volume', 'vote', 'voyage', 'wage', 'wagon', 'wait', 'walk', 'wall', 'walnut', 'want', 'warfare', 'warm', 'warrior', 'wash', 'wasp', 'waste', 'water', 'wave', 'way', 'wealth', 'weapon', 'wear', 'weasel', 'weather', 'web', 'wedding', 'weekend', 'weird', 'welcome', 'west', 'wet', 'whale', 'what', 'wheat', 'wheel', 'when', 'where', 'whip', 'whisper', 'wide', 'width', 'wife', 'wild', 'will', 'win', 'window', 'wine', 'wing', 'wink', 'winner', 'winter', 'wire', 'wisdom', 'wise', 'wish', 'witness', 'wolf', 'woman', 'wonder', 'wood', 'wool', 'word', 'work', 'world', 'worry', 'worth', 'wrap', 'wreck', 'wrestle', 'wrist', 'write', 'wrong', 'yard', 'year', 'yellow', 'you', 'young', 'youth', 'zebra', 'zero', 'zone', 'zoo']

  let mnemonic = ''
  for (let i = 0; i < 12; i++) {
    mnemonic += ' ' + MNEMONIC_CHOICES[Math.round(Math.random() * 2048)]
  }
  return mnemonic.trim()
}
const removeInitialSlash = function (path) {
  if (path.indexOf('/') === 0) {
    return path.substr(1)
  }
  return path
}

// logging
var logKeeper = []
const LOG_ERRORS = true
const felog = function (...args) {
  if (LOG_ERRORS) {
    if (!LOG_DEBUGS) {
      console.log('*********** Last 10 logs before next error')
      logKeeper.forEach(alog => console.log(...alog.args))
      logKeeper = []
    }
    console.error(...args)
  }
}
const LOG_DEBUGS = false
const fdlog = function (...args) {
  if (LOG_DEBUGS) {
    console.log(...args)
  } else {
    logKeeper.push({ args: [...args] })
    if (logKeeper.length > 20) logKeeper.shift()
  }
}

// Interface
module.exports = fdsFairOs
