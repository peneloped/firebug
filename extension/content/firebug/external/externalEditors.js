/* See license.txt for terms of usage */

FBL.ns(function() { with (FBL)
{
    const Cc = Components.classes;
    const Ci = Components.interfaces;

    const DirService =  CCSV("@mozilla.org/file/directory_service;1", "nsIDirectoryServiceProvider");
    const NS_OS_TEMP_DIR = "TmpD"
    const nsIFile = Ci.nsIFile;
    const nsILocalFile = Ci.nsILocalFile;
    const nsISafeOutputStream = Ci.nsISafeOutputStream;
    const nsIURI = Ci.nsIURI;

    var editors = [];
    var externalEditors = [];
    var temporaryFiles = [];
    var temporaryDirectory = null;

    var syncFilesToEditor = false;  // TODO pref

    Firebug.ExternalEditors = extend(Firebug.Module,
    {
        // *************** implement Module *****************************************************

        initializeUI: function()
        {
            Firebug.Module.initializeUI.apply(this, arguments);

            this.loadExternalEditors();

            // we listen for panel update
            Firebug.registerUIListener(this);
        },

        updateOption: function(name, value)
        {
            if (name.substr(0, 15) == "externalEditors")
                this.loadExternalEditors();
        },

        shutdown: function()
        {
             this.deleteTemporaryFiles();
        },

        // ----------------------------------------------------------------------------------
        // UIListener
        onPanelNavigate: function(location, panel)
        {
            if (!syncFilesToEditor)
                return;

            if (location instanceof CompilationUnit)
                openNewTab('http://localhost:8080/coding.html#file=' + location.url);
        },

        onObjectSelected: function(link, panel)
        {
            if (!syncFilesToEditor)
                return;

            if (link instanceof SourceLink)
            {
                openNewTab('http://localhost:8080/coding.html#file=' + sourceLink.href + "&line=" + sourceLink.line);
            }
        },
        // ----------------------------------------------------------------------------------

        registerEditor: function()
        {
            editors.push.apply(editors, arguments);
        },

        getRegisteredEditors: function()
        {
            var newArray = [];
            if ( editors.length > 0 )
            {
                newArray.push.apply(newArray, editors);
                if ( externalEditors.length > 0 )
                    newArray.push("-");
            }
            if ( externalEditors.length > 0 )
                newArray.push.apply(newArray, externalEditors);

            return newArray;
        },

        loadExternalEditors: function()
        {
            const prefName = "externalEditors";
            const editorPrefNames = ["label", "executable", "cmdline", "image"];

            externalEditors = [];
            var list = Firebug.getPref(Firebug.prefDomain, prefName).split(",");
            for (var i = 0; i < list.length; ++i)
            {
                var editorId = list[i];
                if ( !editorId || editorId == "")
                    continue;
                var item = { id: editorId };
                for( var j = 0; j < editorPrefNames.length; ++j )
                {
                    try {
                        item[editorPrefNames[j]] = Firebug.getPref(Firebug.prefDomain, prefName+"."+editorId+"."+editorPrefNames[j]);
                    }
                    catch(exc)
                    {
                    }
                }
                if ( item.label && item.executable )
                {
                    if (!item.image)
                        item.image = getIconURLForFile(item.executable);
                    externalEditors.push(item);
                }
            }
            return externalEditors;
        },

        getDefaultEditor: function()
        {
            return externalEditors[0] || editors[0];
        },

        count: function()
        {
            return externalEditors.length + editors.length;
        },

        // ********* overlay menu support
        //
        onEditorsShowing: function(popup)
        {
            var editors = this.getRegisteredEditors();
            if ( editors.length > 0 )
            {
                var lastChild = popup.lastChild;
                FBL.eraseNode(popup);
                var disabled = (!Firebug.currentContext);
                for( var i = 0; i < editors.length; ++i )
                {
                    if (editors[i] == "-")
                    {
                        FBL.createMenuItem(popup, "-");
                        continue;
                    }
                    var item = {label: editors[i].label, image: editors[i].image,
                                    nol10n: true, disabled: disabled };
                    var menuitem = FBL.createMenuItem(popup, item);
                    menuitem.setAttribute("command", "cmd_openInEditor");
                    menuitem.value = editors[i].id;
                }
                FBL.createMenuItem(popup, "-");
                popup.appendChild(lastChild);
            }
        },

        openEditorList: function()
        {
            var args = {
                FBL: FBL,
                prefName: Firebug.prefDomain + ".externalEditors"
            };
            openWindow("Firebug:ExternalEditors", "chrome://firebug/content/external/editors.xul", "", args);
        },

        appendContextMenuItem: function(items, url, line)
        {
            var editor = this.getDefaultEditor();
            items.push(
                {label: editor.label,
                 image: editor.image,
                 command: function(){
                        Firebug.ExternalEditors.open(url, line)
                    }
                }
            );
        },

        openContext: function(context, editorId)
        {
            var location;
            if (context)
            {
                var panel = Firebug.chrome.getSelectedPanel();
                if (panel)
                {
                    location = panel.location;
                    if (!location && panel.name == "html")
                        location = context.window.document.location;
                    if (location && (location instanceof Firebug.SourceFile || location instanceof CSSStyleSheet ))
                        location = location.href;
                }
            }
            if (!location)
            {
                if (Firebug.tabBrowser.currentURI)
                    location = Firebug.tabBrowser.currentURI.asciiSpec;
            }
            if (!location)
                return;
            location = location.href || location.url || location.toString();
            if (Firebug.filterSystemURLs && isSystemURL(location))
                return;

            this.open(location, null, editorId, context)
        },

        open: function(href, line, editorId, context)
        {
            try
            {
                if (!href)
                    return;
                var editor = null;
                if (editorId)
                {
                    var list = extendArray(externalEditors, editors);
                    for( var i = 0; i < list.length; ++i )
                    {
                        if (editorId == list[i].id)
                        {
                            editor = list[i];
                            break;
                        }
                    }
                }
                else
                    editor = this.getDefaultEditor();

                if (!editor)
                     return;

                if (editor.handler)
                {
                    editor.handler(href,line);
                    return;
                }
                var args = [];
                var localFile = null;
                var targetAdded = false;
                var cmdline = editor.cmdline
                if (cmdline)
                {
                    cmdline = cmdline.replace(' ', '\x00', 'g')

                    if(cmdline.indexOf("%line")>-1)
                    {
                        line = parseInt(line);
                        if(typeof line == 'number' && !isNaN(line))
                            cmdline = cmdline.replace('%line', line);
                        else //don't send argument with bogus line number
                        {
                            var i = cmdline.indexOf("%line");
                            var i2 = cmdline.indexOf("\x00", i);
                            if(i2 == -1)
                                i2 = cmdline.length;
                            var i1 = cmdline.lastIndexOf("\x00", i);
                            if(i1 == -1)
                                i1 = 0;
                            cmdline = cmdline.substring(0, i1) + cmdline.substr(i2);
                        }
                    }
                    if(cmdline.indexOf("%url")>-1)
                    {
                        cmdline = cmdline.replace('%url', href, 'g');
                        targetAdded = true;
                    }
                    else if ( cmdline.indexOf("%file")>-1 )
                    {
                        localFile = this.getLocalSourceFile(context, href);
                        if (localFile)
                        {
                            cmdline = cmdline.replace('%file', localFile, 'g');
                            targetAdded = true;
                        }
                    }

                    cmdline.split(/\x00+/).forEach(function(x){ if(x) args.push(x) })
                }
                if (!targetAdded)
                {
                    localFile = this.getLocalSourceFile(context, href);
                    if (!localFile)
                        return;
                    args.push(localFile);
                }

                FBL.launchProgram(editor.executable, args);
            } catch(exc) { ERROR(exc); }
        },        

        // ********************************************************************************************

        getLocalSourceFile: function(context, href)
        {
            var filePath = getLocalOrSystemPath(href)
            if ( filePath )
                return filePath;

            var data;
            if (context)
            {
                data = context.sourceCache.loadText(href);
            }
            else
            {
                // xxxHonza: if the fake context is used the source code is always get using
                // (a) the browser cache or (b) request to the server.
                var selectedBrowser = Firebug.chrome.getCurrentBrowser();
                var ctx = {
                    browser: selectedBrowser,
                    window: selectedBrowser.contentWindow
                };
                data = new Firebug.SourceCache(ctx).loadText(href);
            }

            if (!data)
                return;

            if (!temporaryDirectory)
            {
                var tmpDir = DirService.getFile(NS_OS_TEMP_DIR, {});
                tmpDir.append("fbtmp");
                tmpDir.createUnique(nsIFile.DIRECTORY_TYPE, 0775);
                temporaryDirectory = tmpDir;
            }

            var lpath = href.replace(/^[^:]+:\/*/g, "").replace(/\?.*$/g, "").replace(/[^0-9a-zA-Z\/.]/g, "_");
            /* dummy comment to workaround eclipse bug */
            if ( !/\.[\w]{1,5}$/.test(lpath) )
            {
                if ( lpath.charAt(lpath.length-1) == '/' )
                    lpath += "index";
                lpath += ".html";
            }

            if ( getPlatformName() == "WINNT" )
                lpath = lpath.replace(/\//g, "\\");

            var file = QI(temporaryDirectory.clone(), nsILocalFile);
            file.appendRelativePath(lpath);
            if (!file.exists())
                file.create(nsIFile.NORMAL_FILE_TYPE, 0664);
            temporaryFiles.push(file.path);

            var converter = CCIN("@mozilla.org/intl/scriptableunicodeconverter", "nsIScriptableUnicodeConverter");
            converter.charset = 'UTF-8'; // TODO detect charset from current tab
            data = converter.ConvertFromUnicode(data);

            var stream = CCIN("@mozilla.org/network/safe-file-output-stream;1", "nsIFileOutputStream");
            stream.init(file, 0x04 | 0x08 | 0x20, 0664, 0); // write, create, truncate
            stream.write(data, data.length);
            if (stream instanceof nsISafeOutputStream)
                stream.finish();
            else
                stream.close();

            return file.path;
        },

        deleteTemporaryFiles: function()  // TODO call on "shutdown" event to modules
        {
            try {
                var file = CCIN("@mozilla.org/file/local;1", "nsILocalFile");
                for( var i = 0; i < temporaryFiles.length; ++i)
                {
                    file.initWithPath(temporaryFiles[i]);
                    if (file.exists())
                        file.remove(false);
                }
            }
            catch(exc)
            {
            }
            try {
                if (temporaryDirectory && temporaryDirectory.exists())
                    temporaryDirectory.remove(true);
            } catch(exc)
            {
            }
        },

    });

    Firebug.registerModule(Firebug.ExternalEditors);

}});