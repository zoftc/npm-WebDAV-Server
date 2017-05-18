import { HTTPCodes, MethodCallArgs, WebDAVRequest } from '../WebDAVRequest'
import { IResource, ResourceType, Simpl_ } from '../../resource/Resource'
import { FSPath } from '../../manager/FSManager'

function copyAllProperties(source : IResource, destination : IResource, callback : Simpl_)
{
    source.getProperties((e, props) => {
        if(e)
        {
            callback(e);
            return;
        }

        let nb = Object.keys(props).length;
        function go(error)
        {
            if(nb <= 0)
                return;
            if(error)
            {
                nb = -1;
                callback(error);
                return;
            }

            --nb;
            if(nb === 0)
                callback(null);
        }

        if(nb === 0)
        {
            callback(null);
            return;
        }

        for(const name in props)
        {
            if(nb <= 0)
                break;
            
            destination.setProperty(name, JSON.parse(JSON.stringify(props[name])), go)
        }
    })
}

function copy(source : IResource, rDest : IResource, destination : FSPath, callback : Simpl_)
{
    // Error wrapper
    function _(error : Error, cb)
    {
        if(error)
            callback(error);
        else
            cb();
    }

    source.type((e, type) => _(e, () => {
        const dest = rDest.fsManager.newResource(destination.toString(), destination.fileName(), type, rDest);

        dest.create((e) => _(e, () => {
            rDest.addChild(dest, (e) => _(e, () => {
                copyAllProperties(source, dest, (e) => _(e, () => {
                    if(!type.isFile)
                    {
                        next();
                        return;
                    }

                    source.read((e, data) => _(e, () => {
                        dest.write(data, (e) => _(e, next))
                    }))

                    function next()
                    {
                        if(!type.isDirectory)
                        {
                            callback(null);
                            return;
                        }

                        source.getChildren((e, children) => _(e, () => {
                            let nb = children.length;
                            function done(error)
                            {
                                if(nb <= 0)
                                    return;
                                if(error)
                                {
                                    nb = -1;
                                    callback(e);
                                    return;
                                }

                                --nb;
                                if(nb === 0)
                                    callback(null);
                            }

                            if(nb === 0)
                            {
                                callback(null);
                                return;
                            }

                            children.forEach((child) => {
                                child.webName((e, name) => {
                                    if(e)
                                        done(e);
                                    else
                                        copy(child, dest, destination.getChildPath(name), done);
                                })
                            })
                        }))
                    }
                }))
            }))
        }))
    }))
}

export default function(arg : MethodCallArgs, callback)
{
    arg.getResource((e, source) => {
        if(e)
        {
            arg.setCode(HTTPCodes.NotFound)
            callback();
            return;
        }

        const overwrite = arg.findHeader('overwrite') !== 'F';

        let destination : any = arg.findHeader('destination');
        if(!destination)
        {
            arg.setCode(HTTPCodes.BadRequest);
            callback();
            return;
        }
        
        destination = destination.substring(destination.indexOf('://') + '://'.length)
        destination = destination.substring(destination.indexOf('/'))
        destination = new FSPath(destination)

        arg.server.getResourceFromPath(destination.getParent(), (e, rDest) => {
            if(e)
            {
                arg.setCode(HTTPCodes.InternalServerError);
                callback();
                return;
            }

            source.type((e, type) => {
                if(e)
                {
                    arg.setCode(HTTPCodes.InternalServerError);
                    callback();
                    return;
                }
                
                function done(overridded : boolean)
                {
                    copy(source, rDest, destination, (e) => {
                        if(e)
                            arg.setCode(HTTPCodes.InternalServerError);
                        else if(overridded)
                            arg.setCode(HTTPCodes.NoContent);
                        else
                            arg.setCode(HTTPCodes.Created);
                        callback();
                    })
                }

                let nb = 0;
                function go(error, destCollision : IResource)
                {
                    if(nb <= 0)
                        return;
                    if(error)
                    {
                        nb = -1;
                        arg.setCode(HTTPCodes.InternalServerError);
                        callback();
                        return;
                    }
                    if(destCollision)
                    {
                        nb = -1;

                        if(!overwrite)
                        { // No overwrite allowed
                            arg.setCode(HTTPCodes.InternalServerError);
                            callback();
                            return;
                        }

                        destCollision.type((e, destType) => {
                            if(e)
                            {
                                callback(e);
                                return;
                            }

                            if(destType !== type)
                            { // Type collision
                                arg.setCode(HTTPCodes.InternalServerError);
                                callback();
                                return;
                            }
                            
                            destCollision.delete((e) => {
                                if(e)
                                {
                                    callback(e);
                                    return;
                                }

                                done(true);
                            })
                        })
                        return;
                    }

                    --nb;
                    if(nb === 0)
                    {
                        done(false);
                    }
                }

                // Find child name collision
                rDest.getChildren((e, children) => {
                    if(e)
                    {
                        go(e, null);
                        return;
                    }

                    nb += children.length;
                    if(nb === 0)
                    {
                        done(false);
                        return;
                    }
                    children.forEach((child) => {
                        child.webName((e, name) => {
                            go(e, name === destination.fileName() ? child : null);
                        })
                    })
                })
            })
        })
    })
}