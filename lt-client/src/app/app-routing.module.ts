import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { FileListComponent } from './file-list/file-list.component';
import { FileComponent } from './file/file.component';

const routes: Routes = [
  {
    path: 'files',
    pathMatch: 'full',
    component: FileListComponent
  },
  {
    path: 'file/:file',
    component: FileComponent
  },
  {
    path: '**',
    redirectTo: '/files'
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
