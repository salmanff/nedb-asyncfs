// fs_obj_aws.js 2020-06
/*
AWS S3 file system object used for freezr and nedb-asyncfs
API docs: using https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html

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
  readall
  mkdirp
  initFS (optional)
  getFileToSend
  removeFolder (like unlink for folders)
  deleteObjectList
- NeDB specific - from nedbtablefuncs.js
  appendNedbTableFile (mimicks functinaility without adding actually appending)
  readNedbTableFile
  deleteNedbTableFiles
  writeNedbTableFile
  crashSafeWriteNedbFile

*/

var async = require('async')
const {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3')

const {
  appendNedbTableFile,
  readNedbTableFile,
  deleteNedbTableFiles,
  writeNedbTableFile,
  crashSafeWriteNedbFile,
  aSyncToPromise
} = require('./nedbtablefuncs.js')


function AWS_FS (credentials = {}, options = {}) {
  // onsole.log("New aws fs")
  this.s3Client = new S3Client({ region: (credentials.region || 'eu-central-1'), credentials: {
    // region: credentials.region || 'eu-central-1',
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey
  } })
  this.bucket = credentials.bucket || 'freezr'
  this.doNotPersistOnLoad = (options.doNotPersistOnLoad === false)? false : true
}

AWS_FS.prototype.name = 'aws'

// primitives
AWS_FS.prototype.initFS = function (callback) {
  // onsole.log(' - aws INITFS ',this.bucket)
  const self = this

  const creaateBucket = async () => {
    await this.s3Client.send(
      new CreateBucketCommand({
        Bucket: self.bucket,
      })
    );
  }
  
  aSyncToPromise(creaateBucket)
  .then(response => {
    return callback(null)
  })
  .catch(err => {
    if (err?.Code === 'BucketAlreadyOwnedByYou' || err?.Code === 'BucketAlreadyExists') {
      callback(null)
    } else {
      console.warn('Error creaateBucket', err);
      return callback(err)
    }
  })
}
AWS_FS.prototype.isPresent = function(file, callback){
  // onsole.log(' - aws-exists ',file, ' in ',this.bucket)
  const self = this

  const getMeta = async function (path) {
    const response = await self.s3Client.send(
      new HeadObjectCommand({
        Bucket: self.bucket,
        Key: path
      })
    )
    return response
  }
  aSyncToPromise(getMeta, file)
  .then(response => {
    return callback(null, true)
  })
  .catch(err => {
    if (err.toString().indexOf('NotFound') === 0) {
      return callback(null, false)
    } else {
      console.warn('Error getMeta', err);
      return callback(err)
    }
  })
}
AWS_FS.prototype.writeFile = function(path, contents, options, callback) {
  // onsole.log(' - aws-writeFile ', path, ' in bucket ', this.bucket)
  const self = this

  const writeFile = async function (path, contents) {
    return await self.s3Client.send(
      new PutObjectCommand({
        Bucket: self.bucket,
        Key: path,
        Body: contents,
      })
    )
  }

  if (options && options.doNotOverWrite) { // Note (ie AAWS overwrites by default)
    const self = this
    self.isPresent(path, function (err, present) {
      if (err) {
        callback(err)
      } else if (present) {
        callback(new Error('File exists - doNotOverWrite option was set and could not overwrite.'))
      } else {
        options.doNotOverWrite = false
        self.writeFile(path, contents, options, callback)
      }
    })
  } else {
    aSyncToPromise(writeFile, path, contents)
    .then(response => {
      return callback(null)
    })
    .catch(err => {
      return callback(err)
    })
  }
}
AWS_FS.prototype.rename = function(fromPath, toPath, callback) {
  // onsole.log(' - aws-rename ',fromPath, toPath)
  const self = this;
  
  const copyFile = async function (fromPath, toPath) {
    await self.s3Client.send(
      new CopyObjectCommand({
        CopySource: self.bucket + '/' + fromPath,
        Bucket: self.bucket,
        Key: toPath,
      })
    )
  }

  aSyncToPromise(copyFile, fromPath, toPath)
    .then(response => {
      return self.unlink(fromPath, callback)
    })
    .catch(err => {
      console.warn('Error copyFile', err);
      return callback(err)
    })

}
AWS_FS.prototype.unlink = function(path, callback) {
  // onsole.log(' - aws-unlink ',path)
  const self = this

  const deleteFile = async function (path) {
    await self.s3Client.send(
      new DeleteObjectCommand({
        Bucket: self.bucket,
        Key: path
      })
    )
  }

  aSyncToPromise(deleteFile, path)
  .then(response => {
    return callback(null)
  })
  .catch(err => {
    console.warn('Error deleteFile', err);
    return callback(err)
  })

}
AWS_FS.prototype.exists = function (file, callback) {
  // onsole.log(' - aws-exists ',file, ' in ',this.bucket)
  this.isPresent(file, function(err, present) {
    return present
  })
}
AWS_FS.prototype.stat = function (file, callback) {
  // onsole.log(' - aws-exists ',file, ' in ',this.bucket)
  const self = this

  const getMeta = async function (path) {
    const response = await self.s3Client.send(
      new HeadObjectCommand({
        Bucket: self.bucket,
        Key: path
      })
    )
    return response
  }
  aSyncToPromise(getMeta, file)
  .then(metadata => {
    if (metadata && metadata.LastModified) metadata.mtimeMs = new Date(metadata.LastModified).getTime()
    if (metadata && metadata.ContentLength) metadata.size = metadata.ContentLength
    metadata.type = 'file'
    return callback(null, metadata)
  })
  .catch(err => {
    console.warn('Error stat', err);
    return callback(err)
  })



}
AWS_FS.prototype.mkdirp = function(path, callback) {
  // onsole.log(' - aws-mkdirp ',path," - not needed")
  return callback(null, null)
}
AWS_FS.prototype.size = function(dirorfFilePath, callback) {
  const self = this
  // onsole.log('readdir in azure ', {dirPath, options })
  const options = {includeMeta: true}

  aSyncToPromise(self.readall, self, dirorfFilePath, options)
  .then(entries => {
    const size = entries.reduce((acc, entry) => acc + entry.Size, 0) 
    return callback(null, size)
  })
  .catch(err => {
    console.warn('Error in aws-size:', err);
    return callback(err)
  })
}

AWS_FS.prototype.readall = async function (self, dirPath, options) {
  const maxPageSize = options?.maxPageSize || 500
  const includeMeta = options?.includeMeta || false
  
  const entries = []
  const command = new ListObjectsV2Command({
    Bucket: self.bucket,
    Prefix: dirPath,
    // Delimiter: '/',
    // The default and maximum number of keys returned is 1000. This limits it to
    // one for demonstration purposes.
    MaxKeys: maxPageSize,
  });

  const standardiseMetaData = function (metadata) {
    if (metadata && metadata.LastModified) metadata.mtimeMs = new Date(metadata.LastModified).getTime()
    if (metadata && metadata.ContentLength) metadata.size = metadata.ContentLength
    if (metadata && metadata.Key) metadata.path = metadata.Key
    return metadata
  }

  let isTruncated = true;
  try { // try first to cach no files error
    const firstResp = await self.s3Client.send(command)
    const { Contents, IsTruncated, NextContinuationToken } = firstResp
    if (Contents?.length > 0) Contents.forEach((c) => entries.push(includeMeta ? standardiseMetaData(c) : c.Key.substring(dirPath.length + 1)));
    isTruncated = IsTruncated;
    command.input.ContinuationToken = NextContinuationToken
  } catch (err) {
    isTruncated = false
    console.warn('Error in readall:', err);
    if (err.message.indexOf('no such file or directory') >= 0) {
      // do nothing
    } else {
      throw err
    }
  }

  while (isTruncated) {
    const resp = await self.s3Client.send(command)
    const { Contents, IsTruncated, NextContinuationToken } = resp
    if (Contents?.length > 0) Contents.forEach((c) => entries.push(includeMeta ? standardiseMetaData(c) : c.Key.substring(dirPath.length + 1)));
    isTruncated = IsTruncated;
    command.input.ContinuationToken = NextContinuationToken;
  }
  return entries
}
AWS_FS.prototype.readdir = function(dirPath,  options = { maxPageSize: 500 }, callback) {
  const self = this
  // onsole.log('readdir in azure ', {dirPath, options })
  options = options || {}
  options.includeMeta = false

  aSyncToPromise(self.readall, self, dirPath, options)
  .then(entries => {
    return callback(null, entries)
  })
  .catch(err => {
    console.warn('Error readall in readdir:', err);
    return callback(err)
  })
}
AWS_FS.prototype.readFile = function(path, options, callback) {
  const self = this

  const readFile = async function (path) {
    const { Body } = await self.s3Client.send(
      new GetObjectCommand({
        Bucket: self.bucket,
        Key: path,
      })
    );
    return await Body.transformToString('utf8')
  }

  aSyncToPromise(readFile, path)
  .then(response => {
    return callback(null, response)
  })
  .catch(err => {
    console.warn('Error readFile', err);
    return callback(err)
  })
}
AWS_FS.prototype.getFileToSend = function(path, options, callback) {
  const self = this
  const getFile = async function (path) {
    const { Body } = await self.s3Client.send(
      new GetObjectCommand({
        Bucket: self.bucket,
        Key: path
      })
    );
    // return await Body / await Body.transformToWebStream() ?  Body.transformToString()
    return await Body.transformToByteArray()
    // return 
    // return 
  }

  aSyncToPromise(getFile, path)
  .then(response => {
    return callback(null, response)
  })
  .catch(err => {
    console.warn('Error in getFileToSend', err);
    return callback(err)
  })
}
AWS_FS.prototype.removeFolder = function(dirPath, callback) {
  const self = this
  // onsole.log('removeFolder in azure ', {dirPath, options })
  options =  { includeMeta: true }

  const deleteObjects = async function (keyArray) {
    if (keyArray.length === 0) return null
    const { Deleted } = await self.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: self.bucket,
        Delete: { Objects: keyArray }
      })
    );
    return Deleted
  }

  aSyncToPromise(self.readall, self, dirPath, options)
  .then(entries => {
    const keyArray = entries.map(e => { return { Key: e.Key } })
    return aSyncToPromise(deleteObjects, keyArray)
  })
  .then(results => {
    return callback(null)
  })
  .catch(err => {
    console.warn('Error in deleteObjects:', err);
    return callback(err)
  })
}
AWS_FS.prototype.deleteObjectList = function (nativeObjectList, callback) {
    const self = this
    // onsole.log('deleteObjectList in azure ', {dirPath, options })

    const deleteObjects = async function (keyArray) {
      const { Deleted } = await self.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: self.bucket,
          Delete: { Objects: keyArray }
        })
      )
      return Deleted
    }

    const keyArray = nativeObjectList.map(e => { 
      if (!e.path && !e.Key)console.warn('deleteObjectList - no path in object', e)
      return { Key: e.path || e.Key } 
    }).filter(e => e.Key)
    if (!keyArray || keyArray.length === 0) {
      return callback(null)
    } else {
      return aSyncToPromise(deleteObjects, keyArray)
      .then(results => {
        return callback(null)
      })
      .catch(err => {
        console.warn('Error in deleteObjectList:', err);
        return callback(err)
      })
    }
}

AWS_FS.prototype.writeNedbTableFile = writeNedbTableFile
AWS_FS.prototype.appendNedbTableFile = appendNedbTableFile
AWS_FS.prototype.readNedbTableFile = readNedbTableFile
AWS_FS.prototype.deleteNedbTableFiles = deleteNedbTableFiles
AWS_FS.prototype.crashSafeWriteNedbFile = crashSafeWriteNedbFile


// Interface
module.exports = AWS_FS;
