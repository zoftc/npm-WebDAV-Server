import { HTTPCodes, MethodCallArgs, WebDAVRequest, ChunkOnDataCallback } from './WebDAVRequest'
import { WebDAVServerOptions, setDefaultServerOptions } from './WebDAVServerOptions'
import { SerializedObject, unserialize, serialize } from '../manager/ISerializer'
import { IResource, ReturnCallback } from '../resource/IResource'
import { FakePrivilegeManager } from '../user/privilege/FakePrivilegeManager'
import { HTTPAuthentication } from '../user/authentication/HTTPAuthentication'
import { IPrivilegeManager } from '../user/privilege/IPrivilegeManager'
import { SimpleUserManager } from '../user/simple/SimpleUserManager'
import { FSManager, FSPath } from '../manager/FSManager'
import { Errors, HTTPError } from '../Errors'
import { RootResource } from '../resource/std/RootResource'
import { IUserManager } from '../user/IUserManager'
import Commands from './commands/Commands'
import * as http from 'http'

export { WebDAVServerOptions } from './WebDAVServerOptions'

export type WebDAVServerStartCallback = (server ?: http.Server) => void;

export interface IResourceTreeNode
{
    r ?: IResource
    resource ?: IResource
    c ?: ResourceTreeNode[]
    children ?: ResourceTreeNode[]
}
export type ResourceTreeNode = IResourceTreeNode | IResource | IResourceTreeNode[] | IResource[];

export class WebDAVServer
{
    public httpAuthentication : HTTPAuthentication
    public privilegeManager : IPrivilegeManager
    public rootResource : IResource
    public userManager : IUserManager
    public options : WebDAVServerOptions
    public methods : object

    protected beforeManagers : WebDAVRequest[]
    protected afterManagers : WebDAVRequest[]
    protected unknownMethod : WebDAVRequest
    protected server : http.Server

    constructor(options ?: WebDAVServerOptions)
    {
        this.beforeManagers = [];
        this.afterManagers = [];
        this.methods = {};
        this.options = setDefaultServerOptions(options);

        this.httpAuthentication = this.options.httpAuthentication;
        this.privilegeManager = this.options.privilegeManager;
        this.rootResource = this.options.rootResource;
        this.userManager = this.options.userManager;

        // Implement all methods in commands/Commands.ts
        for(const k in Commands)
            if(k === 'NotImplemented')
                this.onUnknownMethod(Commands[k]);
            else
                this.method(k, Commands[k]);
    }

    getResourceFromPath(path : FSPath | string[] | string, callback : ReturnCallback<IResource>)
    getResourceFromPath(path : FSPath | string[] | string, rootResource : IResource, callback : ReturnCallback<IResource>)
    getResourceFromPath(path : FSPath | string[] | string, callbackOrRootResource : ReturnCallback<IResource> | IResource, callback ?: ReturnCallback<IResource>)
    {
        let rootResource : IResource;

        if(callbackOrRootResource instanceof Function)
        {
            callback = callbackOrRootResource;
            rootResource = this.rootResource;
        }
        else
            rootResource = callbackOrRootResource;

        let paths : FSPath
        if(path.constructor === FSPath)
            paths = path as FSPath;
        else
            paths = new FSPath(path);
        
        if(paths.isRoot())
        {
            callback(null, rootResource);
            return;
        }

        rootResource.getChildren((e, children) => {
            if(e)
            {
                callback(e, null);
                return;
            }
            if(children.length === 0)
            {
                callback(Errors.ResourceNotFound, null);
                return;
            }

            let found = false;
            let nb = children.length;
            function done()
            {
                --nb;
                if(nb === 0 && !found)
                    process.nextTick(() => callback(Errors.ResourceNotFound, null));
            }

            for(const k in children)
            {
                if(found)
                    break;

                children[k].webName((e, name) => {
                    if(name === paths.rootName())
                    {
                        found = true;
                        paths.removeRoot();
                        this.getResourceFromPath(paths, children[k], callback);
                        return;
                    }
                    process.nextTick(done);
                })
            }
        })
    }

    addResourceTree(resoureceTree : ResourceTreeNode, callback : (e : Error) => void)
    addResourceTree(rootResource : IResource, resoureceTree : ResourceTreeNode, callback : (e : Error) => void)
    addResourceTree(_rootResource : IResource | ResourceTreeNode, _resoureceTree : ResourceTreeNode | (() => void), _callback ?: (e : Error) => void)
    {
        let rootResource : IResource
        let resoureceTree : ResourceTreeNode
        let callback = _callback;

        if(!callback)
        {
            resoureceTree = _rootResource;
            rootResource = this.rootResource;
            callback = _resoureceTree as (e : Error) => void;
        }
        else
        {
            resoureceTree = _resoureceTree;
            rootResource = _rootResource as IResource;
        }

        if(resoureceTree.constructor === Array)
        {
            const array = resoureceTree as any[];
            if(array.length === 0)
            {
                callback(null);
                return;
            }

            let nb = array.length;
            const doneArray = function(e)
            {
                if(nb <= 0)
                    return;
                if(e)
                {
                    nb = -1;
                    callback(e);
                    return;
                }
                --nb;
                if(nb === 0)
                    callback(null);
            }

            array.forEach((r) => this.addResourceTree(rootResource, r, doneArray));
        }
        else if((resoureceTree as IResource).fsManager)
        { // resoureceTree is IResource
            rootResource.addChild(resoureceTree as IResource, callback);
        }
        else
        { // resoureceTree is IResourceTreeNode
            const irtn = resoureceTree as IResourceTreeNode;
            const resource = irtn.r ? irtn.r : irtn.resource;
            const children = irtn.c ? irtn.c : irtn.children;
            rootResource.addChild(resource, (e) => {
                if(e)
                {
                    callback(e);
                    return;
                }

                if(children && children.constructor !== Array)
                {
                    this.addResourceTree(resource, children, callback)
                    return;
                }

                if(!children || children.length === 0)
                {
                    callback(null);
                    return;
                }

                let nb = children.length;
                function done(e)
                {
                    if(nb <= 0)
                        return;
                    if(e)
                    {
                        nb = -1;
                        callback(e);
                        return;
                    }
                    --nb;
                    if(nb === 0)
                        callback(null);
                }

                children.forEach((c) => this.addResourceTree(resource, c, done));
            })
        }
    }

    onUnknownMethod(unknownMethod : WebDAVRequest)
    {
        this.unknownMethod = unknownMethod;
    }

    start(port : number)
    start(callback : WebDAVServerStartCallback)
    start(port : number, callback : WebDAVServerStartCallback)
    start(port ?: number | WebDAVServerStartCallback, callback ?: WebDAVServerStartCallback)
    {
        let _port : number = this.options.port;
        let _callback : WebDAVServerStartCallback;

        if(port && port.constructor === Number)
        {
            _port = port as number;
            if(callback)
            {
                if(callback instanceof Function)
                    _callback = callback;
                else
                    throw new Error('Illegal arguments');
            }
        }
        else if(port && port.constructor === Function)
        {
            _port = this.options.port;
            _callback = port as WebDAVServerStartCallback;
            if(callback)
                throw new Error('Illegal arguments');
        }

        if(!this.server)
        {
            this.server = http.createServer((req : http.IncomingMessage, res : http.ServerResponse) =>
            {
                let method : WebDAVRequest = this.methods[this.normalizeMethodName(req.method)];
                if(!method)
                    method = this.unknownMethod;

                MethodCallArgs.create(this, req, res, (e, base) => {
                    if(e)
                    {
                        if(e === Errors.AuenticationPropertyMissing)
                            base.setCode(HTTPCodes.Forbidden);
                        else
                            base.setCode(HTTPCodes.InternalServerError);
                        res.end();
                        return;
                    }

                    base.exit = () =>
                    {
                        base.response.end();
                        this.invokeAfterRequest(base, null);
                    };

                    if(!this.options.canChunk || !method.startChunked || base.contentLength <= 0)
                    {
                        const go = () =>
                        {
                            this.invokeBeforeRequest(base, () => {
                                method(base, base.exit);
                            })
                        }

                        if(base.contentLength <= 0)
                        {
                            base.data = new Buffer(0);
                            go();
                        }
                        else
                        {
                            const data = new Buffer(base.contentLength);
                            let index = 0;
                            req.on('data', (chunk) => {
                                if(chunk.constructor === String)
                                    chunk = new Buffer(chunk as string);
                                
                                for(let i = 0; i < chunk.length && index < data.length; ++i, ++index)
                                    data[index] = (chunk as Buffer)[i];
                                
                                if(index >= base.contentLength)
                                {
                                    base.data = data;
                                    go();
                                }
                            });
                        }
                    }
                    else
                    {
                        this.invokeBeforeRequest(base, () => {
                            this.invokeBeforeRequest(base, () => {
                                method.startChunked(base, (error : HTTPError, onData : ChunkOnDataCallback) => {
                                    if(error)
                                    {
                                        base.setCode(error.HTTPCode);
                                        base.exit();
                                        return;
                                    }

                                    if(!onData)
                                    {
                                        base.exit();
                                        return;
                                    }
                                    
                                    let size = 0;
                                    req.on('data', (chunk) => {
                                        if(chunk.constructor === String)
                                            chunk = new Buffer(chunk as string);
                                        size += chunk.length;
                                        
                                        onData(chunk as Buffer, size === chunk.length, size >= base.contentLength);
                                    });
                                });
                            })
                        })
                    }
                })
            })
        }

        this.server.listen(_port, this.options.hostname, () => {
            if(_callback)
                _callback(this.server);
        });
    }

    stop(callback : () => void)
    {
        if(this.server)
        {
            this.server.close(callback);
            this.server = null;
        }
        else
            process.nextTick(callback);
    }

    load(obj : SerializedObject, managers : FSManager[], callback: (error : Error) => void)
    {
        unserialize(obj, managers, (e, r) => {
            if(!e)
            {
                this.rootResource = r;
                callback(null);
            }
            else
                callback(e);
        })
    }

    save(callback : (error : Error, obj : any) => void)
    {
        serialize(this.rootResource, callback);
    }

    method(name : string, manager : WebDAVRequest)
    {
        this.methods[this.normalizeMethodName(name)] = manager;
    }

    beforeRequest(manager : WebDAVRequest)
    {
        this.beforeManagers.push(manager);
    }
    afterRequest(manager : WebDAVRequest)
    {
        this.afterManagers.push(manager);
    }

    protected normalizeMethodName(method : string) : string
    {
        return method.toLowerCase();
    }

    protected invokeBARequest(collection : WebDAVRequest[], base : MethodCallArgs, callback)
    {
        function callCallback()
        {
            if(callback)
                process.nextTick(callback);
        }

        if(collection.length === 0)
        {
            callCallback();
            return;
        }

        base.callback = next;
        let nb = collection.length + 1;
        
        function next()
        {
            --nb;
            if(nb === 0)
            {
                callCallback();
            }
            else
                process.nextTick(() => collection[collection.length - nb](base, next))
        }
        next();
    }
    protected invokeBeforeRequest(base : MethodCallArgs, callback)
    {
        this.invokeBARequest(this.beforeManagers, base, callback);
    }
    protected invokeAfterRequest(base : MethodCallArgs, callback)
    {
        this.invokeBARequest(this.afterManagers, base, callback);
    }
}
