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
  fdlog('fdsFairOs  - new fds credentials to set ', { credentials, options })
  this.credentials = credentials
  this.extraCreds = options.extraCreds || null
  this.existingPaths = []
  this.doNotPersistOnLoad = (options.doNotPersistOnLoad !== false)
}

fdsFairOs.prototype.name = 'fdsFairOs'

// primitives
fdsFairOs.prototype.initFS = function (callback) {
  fdlog('fdsFairOs  - initFS ', this.credentials, ' have cookie? ', (this.cookie ? 'yes ' : 'NO!!!!!'))
  return this.getAuth(null, function (err) {
    callback(err)
  })
}
fdsFairOs.prototype.mkdirp = function (path, callback) {
  fdlog('fdsFairOs  - mkdirp ', path)
  return this.getOrMakeFolders(path, { doNotMake: false }, function (err) {
    callback(err, null)
  })
}
fdsFairOs.prototype.unlink = function (path, try2, callback) {
  if (!callback) { callback = try2; try2 = false }
  fdlog(' - fds-unlink ', path)
  const self = this

  this.getAuth(null, function (err) {
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
          try {
            unlinkReturns = JSON.parse(unlinkReturns)
          } catch (e) {
            felog('could not parse unlinkreturns ', unlinkReturns, e)
            unlinkReturns = null
          }

          if (!unlinkReturns) {
            callback(new Error('fds unlink: unparse-able response from unlink for ' + path))
          } else if (unlinkReturns.code === 404 && unlinkReturns.message.indexOf('file does not exist') > 0) {
            const localFilePath = self.credentials.tempLocalFolder + '/' + path
            if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath)
            callback(null)
          } else if (unlinkReturns.code !== 200) {
            self.fileExists(path, (err2, res) => {
              if (res && (res.present || res.present === false)) {
                callback(null)
              } else if (!try2 && isExpiryError(res, self.cookie)) {
                felog('unlink - re-authing with new cookie')
                self.getAuth({ ignoreCookie: true }, function (err) {
                  if (err) {
                    callback(err)
                  } else {
                    self.unlink(path, true, callback)
                  }
                })
              } else {
                felog('error in unlink ing file ', { unlinkReturns, err2 })
                callback(new Error('fds unlink: ' + (unlinkReturns.message ? unlinkReturns.message : 'unlink - uknown err') + ' for ' + path))
              }
            })
          } else {
            const localFilePath = self.credentials.tempLocalFolder + '/' + path
            if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath)
            callback(null)
          }
        })
      })
      unlinkReq.on('error', (error) => {
        felog('error in deleting file ', error)
        if (!try2 && isExpiryError(error, self.cookie)) {
          felog('unlink - re-authing with new cookie (onerr) ')
          self.getAuth({ ignoreCookie: true }, function (err) {
            if (err) {
              felog('error getting auth after expiry on unlink ')
              callback(err)
            } else {
              self.unlink(path, true, callback)
            }
          })
        } else {
          callback(error)
        }
      })
      unlinkReq.write(JSON.stringify(unlinkParams))
      unlinkReq.end()
    }
  })
}
fdsFairOs.prototype.writeFile = function (path, contents, options, callback) {
  fdlog('fdsFairOs  - writefile ', path, ' have cookie? ', (this.cookie ? 'yes ' : 'NO!!!!!'))
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
      self.getAuth(null, cb)
    },
    function (cb) {
      self.fileExists(path, cb)
    },
    function (returns, cb) {
      if (returns.present && options.doNotOverWrite) {
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
        var writeReturns = ''
        writeResp.on('data', (partFile) => {
          writeReturns += partFile.toString()
        })
        writeResp.on('end', (writeEnd) => {
          if (!writeReturns) {
            felog('error in uploading file ', { writeReturns })
            cb(new Error('fds write: Nothing returned for ' + path))
          } else {
            try {
              writeReturns = JSON.parse(writeReturns)
            } catch (e) {
              writeReturns = { code: 500, originalText: writeReturns, Responses: [{ message: 'fds file upload: unparse-able response on write return message for ' + path }] }
            }

            if (writeReturns.Responses && writeReturns.Responses.length > 0 && writeReturns.Responses[0].message && writeReturns.Responses[0].message.indexOf('uploaded successfully') >= 0) {
              cb(null)
            } else if (writeReturns.Responses && writeReturns.Responses.length > 0 && writeReturns.Responses[0].message && writeReturns.Responses[0].message.indexOf('payload is greater than 4096') >= 0) {
              self.readFile(path, options, function (err, filecont) {
                if (!err && filecont === contents) {
                  callback(null)
                } else {
                  if (err) console.warn('error in 4096 resolution ', err)
                  callback(new Error('payload 4096 error unsolved for ' + path))
                }
              })
            } else {
              felog('fds write error for ', { path }, ' writeReturns: ' + JSON.stringify(writeReturns))
              const message = (writeReturns.Responses && writeReturns.Responses.length > 0 && writeReturns.Responses[0].message) ? writeReturns.Responses[0].message : JSON.stringify('unknown message for ' + path + ' - ' + writeReturns.Responses)
              cb(new Error(message))
            }
          }
        })
      })
      writeReq.on('error', (error) => {
        felog('error in uploading file ', error)
        cb(error)
      })
      form.pipe(writeReq)
    }
  ], function (err) {
    if (err) felog('end of dfs -write for ' + path, { err })
    callback(err)
  })
}
fdsFairOs.prototype.rename = function (fromPath, toPath, callback) {
  // check exists
  fdlog('fdsFairOs  - rename ', fromPath, ' have cookie? ', (this.cookie ? 'yes ' : 'NO!!!!!'))
  const self = this

  async.waterfall([
    function (cb) {
      self.getAuth(null, cb)
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
      self.writeFile(toPath, file, { doNotOverWrite: false }, function (err) {
        if (err) felog('fds rename write err ', { err })
        cb(err)
      })
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
  const self = this
  if (!options) options = {}
  self.getFileToSend(path, function (err, returns) {
    if (err) {
      if (err.message === 'fds - pod not open' && !options.try2) {
        reOpenPod(self, function (err) {
          if (err) {
            felog('reopening pod failed ', { err, options })
            callback(err)
          } else {
            options.try2 = true
            self.readFile(path, options, callback)
          }
        })
      } else if (isExpiryError(err, self.cookie) && !options.try2) {
        self.getAuth({ ignoreCookie: true }, function (err, ret) {
          if (err) {
            callback(err)
          } else {
            options.try2 = true
            self.readFile(path, options, callback)
          }
        })
      } else {
        felog('file read err message', err.message)
        callback(err)
      }
    } else {
      callback(null, returns.toString())
    }
  })
}
fdsFairOs.prototype.readdir = function (dirpath, options, callback) {
  // no options used
  fdlog('fds reading dir ', dirpath, ' have cookie? ', (this.cookie ? 'yes ' : 'NO!!!!!'))
  /* sample output from dfs
  { "dirs": [ {"name": "workspace", "content_type": "inode/directory", "creation_time": "1640293213", "modification_time": "1640415770", "access_time": "1640293213" } ],
    "files": [  {"name": "renamed-test.txt", "content_type": "", "size": "363", "block_size": "1000000",  "creation_time": "1640415769", "modification_time": "1640415769", "access_time": "1640415771" } }
  */
  const self = this
  if (!options) options = {}
  self.getAuth(null, function (err) {
    if (err) {
      felog('error checking for ' + dirpath)
      callback(err)
    } else {
      const cookieOpts = { headers: { Cookie: self.cookie.text } }
      https.get('https://' + self.credentials.fdsGateway + '/v1/dir/ls?pod_name=' + self.credentials.podname + '&dir_path=/' + dirpath, cookieOpts, (res) => {
        var fullfile = ''
        res.on('data', (getFileReturns) => {
          fullfile += getFileReturns.toString()
        })
        res.on('end', (ret) => {
          let returns = fullfile
          var files = []

          try {
            returns = returns.toString()
            returns = JSON.parse(returns)
          } catch (e) {
            felog('fds dir read: unparse-able response in return message - ', returns, e)
            returns = { error: 'fds readdir: unparse-able response' }
          }
          if (!returns) returns = { error: 'read dir no returns for ' + dirpath }
          if (returns.dirs && returns.dirs.length > 0) {
            returns.dirs.forEach(item => { files.push(item.name) })
          }
          if (returns.files && returns.files.length > 0) {
            returns.files.forEach(item => { files.push(item.name) })
          }

          if (returns.code === 404 || (returns.message && returns.message.indexOf('file not present') > 0)) {
            callback(null, [])
          } else if (!options.try2 && isExpiryError(returns, self.cookie)) {
            felog('readdir - re-authing with new cookie')
            self.getAuth({ ignoreCookie: true }, function (err, ret) {
              if (err) {
                callback(err)
              } else {
                options.try2 = true
                return self.readdir(dirpath, options, callback)
              }
            })
          } else if (returns.error) {
            callback(new Error(returns.error))
          } else {
            callback(null, files)
          }
        }).on('error', (e) => {
          felog('fds readdir error', e)
          callback(e)
        })
      })
    }
  })
}
fdsFairOs.prototype.stat = function (path, callback) {
  const cookieOpts = { headers: { Cookie: this.cookie.text } }
  const self = this
  this.getAuth(null, function (err) {
    if (err) {
      felog('error checking auth for stat ', err)
      callback(err)
    } else {
      https.get('https://' + self.credentials.fdsGateway + '/v1/file/stat?pod_name=' + self.credentials.podname + '&file_path=/' + path, cookieOpts, (res) => {
        res.on('data', (returns) => {
          try {
            returns = returns.toString()
            returns = JSON.parse(returns)
          } catch (e) {
            console.warn('fds file stat 2: unparse-able response in return message ' + JSON.stringify(returns), e)
            returns = { error: 'fds file stat: unparse-able response from file stats 2' }
          }
          if (!returns) {
            callback('file stat - no returns for ' + path)
          } else if (returns.code === 400) {
            callback(new Error((returns.message ? returns.message : 'unknown err') + ' for ' + path))
          } else if (returns.error) {
            callback(new Error(returns.error + ' for ' + path))
          } else if (returns.code === 500) {
            if (!returns.message || returns.message.indexOf('file not found') < 0) {
              callback(new Error('SNBH - file stats error 500 should only be file not found for ' + path))
            } else {
              https.get('https://' + self.credentials.fdsGateway + '/v1/dir/stat?pod_name=' + self.credentials.podname + '&dir_path=/' + path, cookieOpts, (res) => {
                res.on('data', (returns) => {
                  try {
                    returns = returns.toString()
                    returns = JSON.parse(returns)
                  } catch (e) {
                    console.warn('fds dir stat: unparse-able response in return message  ' + JSON.stringify(returns), e)
                    returns = { code: 400, error: 'unknown error in dir stat', message: 'fds dirstat: unparse-able response from dir stat' }
                  }
                  if (returns.code === 400) {
                    callback(new Error((returns.message ? returns.message : 'unknown err') + ' for ' + path))
                  } else if (returns.code === 500) {
                    if (!returns.message || returns.message.indexOf('directory not present') < 0) {
                      callback(new Error('SNBH - folder stats error 500 should only be directory not present for ' + path))
                    } else {
                      callback(new Error(FILE_DOES_NOT_EXIT))
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
          callback((e.message ? e.message : 'unknown err') + ' for ' + path)
        })
      })
    }
  })
}

// Other file system...
fdsFairOs.prototype.getFileToSend = function (path, callback) {
  const self = this
  fdlog('getFileToSend ', path, ' have cookie? ', (this.cookie ? 'yes ' : 'NO!!!!!'))

  this.getAuth(null, function (err) {
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
          let errInFile = false
          let testJson = null
          try {
            testJson = JSON.parse(fullfile)
            if (testJson.code === 400 || testJson.code === 500 || testJson.message.indexOf('pod not open') > -1 || testJson.message.indexOf('error uploading data') > -1 || isExpiryError(testJson, self.cookie)) errInFile = true
          } catch (e) {
            // okay to get error cause the file could be anything...
          }
          if (errInFile) {
            // console.log() - note unresolvable bug where a file cannot be read if it is a json with message: pod not opn
            const message = (testJson && testJson.message) ? (testJson.message.indexOf('pod not open') > -1 ? 'fds - pod not open' : (isExpiryError(testJson, self.cookie) ? '' : ('fds - unknown error 1'))) : 'unknown error 2'
            callback(new Error('getFileToSend err: ' + message + + ' for ' + path))
          } else {
            callback(null, fullfile)
          }
        })
        getFileResp.on('data', (getFileReturns) => {
          fullfile += getFileReturns.toString()
        })
      })
      getFileReq.on('error', (error) => {
        felog('error in getting file ', error)
        callback(new Error('getFileToSend err: ' + (error.message ? error.message : 'uknown err 3') + ' for '))
      })
      getFileReq.write('')
      getFileReq.end()
    }
  })
}
fdsFairOs.prototype.removeFolder = function (dirpath, callback) {
  fdlog(' - fds -removeFolder ', dirpath)
  const self = this
  self.existingPaths = self.existingPaths.filter(item => item.indexOf('/' + dirpath) !== 0)
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
      self.removeEmptyFolder(dirpath, callback)
    }
  })
}
fdsFairOs.prototype.removeEmptyFolder = function (dirpath, callback) {
  fdlog(' - fds -removeEmptyFolder ', dirpath)
  const self = this
  self.getAuth(null, function (err) {
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
          try {
            rmdirReturns = rmdirReturns.toString()
            rmdirReturns = JSON.parse(rmdirReturns)
          } catch (e) {
            felog('fds rmdir: unparse-able response in return message ' + JSON.stringify(rmdirReturns), e)
            rmdirReturns = { error: 'bad response', message: 'fds rmdir: unparse-able response in return message' }
          }
          self.existingPaths.splice(self.existingPaths.indexOf(dirpath), 1)

          if (rmdirReturns && rmdirReturns.error === 'bad response') {
            callback(new Error(rmdirReturns.message + ' for ' + dirpath))
          } else if (!rmdirReturns || rmdirReturns.code !== 200) {
            self.folderExists(dirpath, (err, res) => {
              if (!err && res && res.present === false) {
                callback(null)
              } else {
                if (err) felog('err in seeing if removable folder exists ', err)
                if (res && res.present) felog('err and res.present ', res)
                felog('error in rmdir ing  ', { rmdirReturns })
                callback(new Error('rmdir: ' + (err.message ? err.message : 'unknown err') + ' for ' + dirpath))
              }
            })
          } else {
            const localFilePath = self.credentials.tempLocalFolder + '/' + dirpath
            if (fs.existsSync(localFilePath)) fs.rmdirSync(localFilePath, { recursive: true, force: true })
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
fdsFairOs.prototype.readNedbTableFile = function (path, options, callback) {
  // read file goes through folder with appends, and adds them to content
  fdlog(' - fds - readNedbTableFile ', path)
  const self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(path)
  let contents = ''
  if (!options) options = {}

  self.readFile(path, {}, (err, mainfileContent) => {
    if (err && err.message !== FILE_DOES_NOT_EXIT) {
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
              callback(null, contents)
            }
          })
        } else if (err) {
          callback(err)
        } else {
          if (contents && contents.length > 1 && contents.slice(contents.length - 2) === '\n\n') contents = contents.slice(0, contents.length - 1)
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
    setTimeout(function () {
      if (err) {
        if (err.message !== FILE_DOES_NOT_EXIT) felog('unlink message was [' + err.message + ']')
        if (err.message === FILE_DOES_NOT_EXIT || err.message.indexOf('file not present') > 0) {
          callback(null)
        } else { //
          felog('err in deleteNedbTableFiles - todo 1: if filenotfound then ignore for file ' + file, err)
          return callback(err)
        }
      } else {
        self.removeFolder(appendDirectory, function (err) {
          if (err && (err.message === FILE_DOES_NOT_EXIT || err.message.indexOf('file not present') > 0)) {
            callback(null)
          } else {
            if (err) felog('err in deleteNedbTableFiles - todo 2: if filenotfound then ignore for file ' + file, err)
            return callback(err)
          }
        })
      }
    }, 2000) // note - this is only used in testing so timeout is okay to keep.
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
      self.writeFile(tempOf(filename), data, {}, function (err) {
        if (err) felog('fds crashSafeWriteNedbFile write rewrote temp file tempOf ', { filename, err })
        return cb(err)
      })
    },
    function (cb) {
      self.rename(tempOf(filename), filename, function (err) {
        if (err) felog('fds crashSafeWriteNedbFile write rename ', { filename, err })
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
    // if (!err) fdlog('end of crashSafeWriteNedbFile write with NO ERR!!!', { err, data })
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
  fdlog(' - fds-getOrMakeFolders ', path, 'have cookie ? ', (this.cookie ? 'yes' : 'NO!!!!!!!!!'))

  const self = this

  this.getAuth(null, function (err) {
    if (err) {
      felog('error checking auth for getOrMakeFolders')
      callback(err)
    } else if (self.existingPaths.includes(path)) {
      callback(null)
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
            fdlog('mkdir ' + currentFolderName + '- already exists ?', { returns })
            if (err) {
              cb(err)
            } else if (returns.present) {
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
                  try {
                    makeDirReturns = makeDirReturns.toString()
                    makeDirReturns = JSON.parse(makeDirReturns)
                  } catch (e) {
                    xc
                    felog('fds mkdir: unparse-able response in return message' + JSON.stringify(makeDirReturns), e)
                    makeDirReturns = { error: 'bad response', message: 'fds mkdir: unparse-able response from dir make' }
                  }
                  if (makeDirReturns && makeDirReturns.error === 'bad response') {
                    callback(new Error('getormakefolders err ' + makeDirReturns.message + ' for ' + path))
                  } else if (makeDirReturns && makeDirReturns.message && makeDirReturns.message.indexOf('directory name already present') > -1) {
                    felog('mkdir snbh - exists but not caught for ' + path, { makeDirReturns })
                    self.existingPaths.push(path)
                    cb(null)
                  } else if (!makeDirReturns || makeDirReturns.code !== 201) {
                    if (makeDirReturns && makeDirReturns.message === 'mkdir: pod not open' && !options.try2) {
                      fdlog('reopening pod in mkdir')
                      reOpenPod(self, function (err) {
                        if (err) {
                          felog('reopening pod failed in mkdir ', { err, options })
                          callback(new Error('mkdir - could not re-opn pod'))
                        } else {
                          fdlog('reopening pod - try 2')
                          options.try2 = true
                          self.getOrMakeFolders(path, options, callback)
                        }
                      })
                    } else {
                      felog('fds mkdir: unparse-able response in return message 2 ', { makeDirReturns })
                      cb(new Error('fds mkdir: ' + ((makeDirReturns && makeDirReturns.message) ? makeDirReturns.message : 'uknown err') + ' for ' + path))
                    }
                  } else {
                    self.existingPaths.push(path)
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
fdsFairOs.prototype.isPresent = function (fileOrFolder, options, callback) {
  if (!options) options = {}
  fdlog('isPresent ', fileOrFolder)
  const self = this
  self.fileExists(fileOrFolder, function (err, returns) {
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
fdsFairOs.prototype.folderExists = function (path, try2, callback) {
  // assume path starts with '/'
  const self = this
  if (!callback) { callback = try2; try2 = false }
  fdlog('fds -folderExists  - self.existingPaths ', self.existingPaths)
  self.getAuth(null, function (err, ret) {
    if (err) {
      felog('error checking auth for folderExists', err)
      callback(err)
    } else if (self.existingPaths.includes(path)) {
      callback(null, { present: true })
    } else {
      const cookieOpts = { headers: { Cookie: self.cookie.text } }
      https.get('https://' + self.credentials.fdsGateway + '/v1/dir/present?pod_name=' + self.credentials.podname + '&dir_path=' + path, cookieOpts, (res) => {
        res.on('data', (returns) => {
          try {
            returns = returns.toString()
            returns = JSON.parse(returns)
          } catch (e) {
            felog('fds dir present: unparse-able response in return message ' + JSON.stringify(returns), e)
            returns = { error: 'bad response', message: 'fds dir present: unparse-able response in return message' }
          }

          if (returns && (returns.present === true || returns.present === false)) {
            if (returns.present === true) self.existingPaths.push(path)
            callback(null, returns)
          } else if (!try2 && isExpiryError(returns, self.cookie)) {
            felog('folderExists - re-authing with new cookie')
            self.getAuth({ ignoreCookie: true }, function (err, ret) {
              if (err) {
                callback(err)
              } else {
                return self.folderExists(path, true, callback)
              }
            })
          } else if (returns && returns.error && typeof returns.error === 'string' && returns.error === 'pod not open') {
            felog('caught error in folderExists ', returns)
            callback(new Error((returns && returns.error)? returns.error: 'folderExists - uknown err for ' + path))
          } else if (!returns) { // snbh
            felog('error 12 - mssing returns in folderExists')
            callback(new Error('fds- unknown error in folderExists'))
          } else {
            felog('error in folder returns ', { returns })
            callback(new Error((returns && returns.message) ? returns.message : 'folderExists: uknown err msg for ' + path))
          }
        }).on('error', (e) => {
          console.error('fds folderExists error', e)
          callback(e)
        })
      })
    }
  })
}
fdsFairOs.prototype.fileExists = function (path, try2, callback) {
  // assumed path does NOT start with '/'
  const cookieOpts = { headers: { Cookie: (this.cookie ? this.cookie.text : 'null - missing cookie') } }
  fdlog('dfs fileExists cookie : ', cookieOpts.headers.Cookie)
  const self = this
  if (!callback) { callback = try2; try2 = false }
  this.getAuth(null, function (err) {
    if (err) {
      felog('error checking auth for fileExists ', err)
      callback(err)
    } else {
      https.get('https://' + self.credentials.fdsGateway + '/v1/file/stat?pod_name=' + self.credentials.podname + '&file_path=/' + path, cookieOpts, (res) => {
        res.on('data', (returns) => {
          try {
            returns = returns.toString()
            returns = JSON.parse(returns)
          } catch (e) {
            console.warn('fds file stat: unparse-able response in return message ' + JSON.stringify(returns), e)
            returns = { error: 'fds file stat: unparse-able response in return message' }
          }
          if (isExpiryError(returns, self.cookie) && !try2) {
            fdlog('fileExists - re-authing with new cookie')
            self.getAuth({ ignoreCookie: true }, function (err, ret) {
              fdlog('fileExists - re-authing with new cookie')
              if (err) {
                callback(err)
              } else {
                return self.fileExists(path, true, callback)
              }
            })
          } else if (returns && returns.code === 400) {
            callback(new Error('fds - fileExists err ' + (returns.message ? returns.message : 'uknown err') + ' for ' + path))
          } else if (returns && returns.code === 500) {
            if (returns.message && returns.message.indexOf('file not found') > -1) {
              callback(null, { present: false })
            } else {
              callback(new Error('SNBH - fileExists - file stats error 500 should only be file nt found for' + path))
            }
          } else if (returns && returns.error) {
            felog('caught error in fileExists', { returns })
            callback(new Error('fds- fileExists err ' + returns.error + ' for ' + path))
          } else if (!returns) {
            callback(new Error('fds- unknown error in fileExists for ' + path))
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
fdsFairOs.prototype.getAuth = function (options = {}, callback) {
  // CHECKS COOKIE - IF exiats and not expired, stays
  // If not, tries to login and store new cookie
  // then tries to pen pod - or if pod doesnt exist, it
  const sanitiseForfdlog = function (creds) {
    var ret = JSON.parse(JSON.stringify(creds))
    delete ret.fdsPass
    return ret
  }
  fdlog('fdsFairOs  - getAuth ', sanitiseForfdlog(this.credentials))
  if (!options) options = {}

  if (this.extraCreds && !this.cookie) { // note only happens on first run of auth
    this.cookie = JSON.parse(JSON.stringify(this.extraCreds))
    this.extraCreds = null
  } else if (this.extraCreds && this.cookie) {
    felog('dbfs_fds No extra creds in this.credentials - SNBH ???')
  }

  if (!this.credentials || !this.credentials.userName || !this.credentials.fdsPass ||
    !this.credentials.podname || !this.credentials.tempLocalFolder || !this.credentials.fdsGateway) {
    callback(new Error('Missing credentials for fds auth check'))
  } else if (!this.cookie || !this.cookie.text || expiredCookie(this.cookie) || options.ignoreCookie) {
    fdlog('logging in again because... cookie is ', this.cookie, 'ignore ? ', options.ignoreCookie)
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
      fdlog('headers ', authResp.headers)
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
          try {
            returns = returns.toString()
            returns = JSON.parse(returns)
          } catch (e) {
            felog('fds login: unparse-able response in return message' + JSON.stringify(returns), e)
            returns = { error: 'unknown error logging in', message: 'bad response from logging in' }
          }
          if (!returns || returns.code !== 200 || returns.error) {
            fdsThis.cookie = {}
            felog('error in returns ', { returns, theCookie })
            callback(new Error('fds login: ' + (returns.message? returns.message : ' ukmown err')))
          } else {
            reOpenPod(fdsThis, callback)
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
const reOpenPod = function (fdsThis, callback) {
  const podParams = {
    pod_name: fdsThis.credentials.podname,
    password: fdsThis.credentials.fdsPass
  }
  fdlog('iiii reopen pod with cookie ', fdsThis.cookie.text, 'and podParams ', podParams)
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
      try {
        podReturns = JSON.parse(podReturns)
      } catch (e) {
        felog('fds pod open: unparse-able response in return message', podReturns, e)
        podReturns = { code: 500, originalText: podReturns, message: 'fds pod open: unparse-able response in return message' }
      }

      if (podReturns && podReturns.code >= 400 && podReturns.code < 500) { // pod does not exist
        if (podReturns.message !== 'pod open: invalid pod name' && podReturns.message !== 'pod open: pod does not exist') {
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
            try {
              podCreateReturns = JSON.parse(podCreateReturns)
            } catch (e) {
              felog('fds pod new: unparse-able response in return message', podCreateReturns, e)
              podCreateReturns = { code: 500, originalText: podCreateReturns, message: 'fds pod new: unparse-able response in return message' }
            }
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
        callback(new Error('fds pod open error : ' + (podReturns.message ? podReturns.message : 'unkown')))
      } else {
        fdlog('existing pod used', { fdsThis })
        callback(null)
      }
    })
  })
  podReq.on('error', (error) => {
    felog('error in pod opening ', error)
    callback('fds- pod open' + (error.message ? error.message : 'uknown err'))
  })
  podReq.write(JSON.stringify(podParams))
  podReq.end()
}
const expiredCookie = function (cookie) {
  if (!cookie || !cookie.expires) return true
  // fdlog('expired cookie ? ' + (new Date().getTime()) + cookie.expires + 'more ? ' + (new Date().getTime() > cookie.expires))
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

const isExpiryError = function (message, cookieObj) {
  // cookieObj used for error checking only
  if (message && message.error) message = message.error // for returned err object
  if (message && message.message) message = message.message // for error objects
  if (!message || typeof message !== 'string') return false
  if (message === 'auth expiration') return true
  if (message.indexOf('user not logged in') > -1) return true
  if (message.indexOf('invalid cookie') > -1) felog('To review - why are we receiving an invalid cookie err ', { message, cookieObj })
  if (message.indexOf('invalid cookie') > -1) return true
  if (message.indexOf('cookie login timeout expired') > -1) return true
  return false
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
      console.warn('*********** Last 10 logs before next error')
      logKeeper.forEach(alog => console.log(...alog.args))
      logKeeper = []
      console.warn('*********** NEXT error')
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
